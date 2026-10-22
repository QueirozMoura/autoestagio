-- Etapa 3.4: canal de envio por e-mail (Gmail). Migração aditiva: só cria tabelas novas.
-- Nada aqui guarda tokens, senhas nem o texto das mensagens: tokens ficam em arquivo local 0600.

-- Destinatários verificados: o endereço PRECISA ter sido encontrado, literalmente, na vaga oficial
-- ou em uma página oficial da empresa. Nunca há endereço deduzido ou adivinhado.
CREATE TABLE verified_recipients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs (id),
  email         TEXT NOT NULL CHECK (email = lower(email) AND email NOT LIKE '% %' AND instr(email, '@') > 1),
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('vaga_oficial', 'pagina_oficial_empresa')),
  source_url    TEXT NOT NULL,
  company_domain TEXT,
  -- SHA-256 do texto em que o endereço foi encontrado (a evidência), não o texto em si.
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  -- Provedor gratuito (gmail.com etc.): só vale com confirmação explícita do usuário.
  freemail      INTEGER NOT NULL DEFAULT 0 CHECK (freemail IN (0, 1)),
  freemail_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (freemail_confirmed IN (0, 1)),
  verified_at   TEXT NOT NULL,
  UNIQUE (job_id, email)
);

-- Autorização explícita, específica e de uso único para cada envio. Amarrada ao conteúdo exato
-- (mensagem + currículo + destinatário): se qualquer coisa mudar, a autorização deixa de valer.
CREATE TABLE email_authorizations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications (id),
  kind           TEXT NOT NULL CHECK (kind IN ('real', 'teste')),
  binding_hash   TEXT NOT NULL CHECK (length(binding_hash) = 64),
  reason         TEXT NOT NULL CHECK (length(reason) > 0),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);

CREATE TRIGGER email_authorizations_single_use BEFORE UPDATE ON email_authorizations
WHEN OLD.used_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'autorização já usada'); END;

-- Cada tentativa de envio. `reservado` é gravado ANTES de chamar o Gmail; se o processo cair, a
-- linha fica `reservado` e a recuperação a manda para intervenção humana (nunca reenvia sozinha).
CREATE TABLE email_dispatches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id   INTEGER NOT NULL REFERENCES applications (id),
  kind             TEXT NOT NULL CHECK (kind IN ('real', 'teste')),
  recipient_id     INTEGER REFERENCES verified_recipients (id),
  recipient_masked TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('reservado', 'aceito', 'rejeitado', 'desconhecido')),
  rfc_message_id   TEXT NOT NULL,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  -- Só a categoria do erro (ex.: "http_403"), nunca a resposta nem o token.
  error_category   TEXT,
  cv_sha256        TEXT NOT NULL CHECK (length(cv_sha256) = 64),
  content_hash     TEXT NOT NULL,
  authorization_id INTEGER NOT NULL REFERENCES email_authorizations (id),
  reserved_at      TEXT NOT NULL,
  finished_at      TEXT,
  CHECK (kind = 'teste' OR recipient_id IS NOT NULL)
);

-- No máximo UMA candidatura real em andamento/aceita/desconhecida por candidatura: o banco impede o
-- reenvio. Só uma tentativa claramente rejeitada libera uma nova.
CREATE UNIQUE INDEX idx_email_dispatches_one_real
  ON email_dispatches (application_id)
  WHERE kind = 'real' AND status IN ('reservado', 'aceito', 'desconhecido');
CREATE INDEX idx_email_dispatches_application ON email_dispatches (application_id);

-- Três coisas diferentes: o Gmail aceitou a mensagem; a entrega foi confirmada; a empresa confirmou
-- o recebimento. Com o escopo mínimo (gmail.send) só a primeira é automática.
CREATE TABLE application_confirmations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications (id),
  kind           TEXT NOT NULL CHECK (kind IN ('aceito_pelo_gmail', 'entrega', 'recebimento_empresa')),
  evidence       TEXT,
  recorded_by    TEXT NOT NULL CHECK (recorded_by IN ('sistema', 'usuario')),
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_application_confirmations_app ON application_confirmations (application_id);
CREATE TRIGGER application_confirmations_no_update BEFORE UPDATE ON application_confirmations
BEGIN SELECT RAISE(ABORT, 'application_confirmations é imutável'); END;
CREATE TRIGGER application_confirmations_no_delete BEFORE DELETE ON application_confirmations
BEGIN SELECT RAISE(ABORT, 'application_confirmations é imutável'); END;
