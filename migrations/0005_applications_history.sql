-- Etapa 3.2: histórico de candidaturas e prevenção de duplicidade.
--
-- Reconstrói `applications` e `application_events` (criadas na 0001, ainda sem uso) com os
-- estados, o canal, a versão exata do currículo (SHA-256) e um histórico imutável. O executor
-- desliga as foreign keys durante a migração e confere `foreign_key_check` antes de confirmar.
-- Linhas existentes (se houver) são copiadas; modo 'manual' vira 'revisao'.

CREATE TABLE applications_new (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Uma candidatura por vaga, garantido pelo banco (UNIQUE), não só pela aplicação.
  job_id                      INTEGER NOT NULL UNIQUE REFERENCES jobs (id),
  mode                        TEXT NOT NULL DEFAULT 'dry-run'
                                CHECK (mode IN ('dry-run', 'revisao', 'auto')),
  status                      TEXT NOT NULL DEFAULT 'preparada'
                                CHECK (status IN (
                                  'preparada', 'aprovada_para_envio', 'enviando', 'enviada',
                                  'entrega_confirmada', 'falhou', 'pendente_intervencao_humana'
                                )),
  channel                     TEXT CHECK (channel IS NULL OR channel IN ('email', 'portal', 'manual')),
  -- Versão exata do currículo usada (SHA-256 do PDF) e só o nome do arquivo, sem caminho.
  cv_sha256                   TEXT NOT NULL CHECK (length(cv_sha256) = 64),
  cv_label                    TEXT NOT NULL,
  -- Elegibilidade no momento da criação. Vaga inapta nunca vira candidatura.
  eligibility_verdict         TEXT NOT NULL CHECK (eligibility_verdict IN ('apto', 'revisao_humana')),
  eligibility_override_reason TEXT,
  profile_hash                TEXT NOT NULL,
  confirmation                TEXT,
  notes                       TEXT,
  applied_at                  TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  -- Quem aprovou uma vaga em revisão humana precisa dizer por quê.
  CHECK (eligibility_verdict = 'apto' OR eligibility_override_reason IS NOT NULL)
);

INSERT INTO applications_new (
  id, job_id, mode, status, cv_sha256, cv_label, eligibility_verdict,
  eligibility_override_reason, profile_hash, confirmation, notes, applied_at, created_at, updated_at
)
SELECT
  id, job_id, CASE mode WHEN 'manual' THEN 'revisao' ELSE mode END, status,
  printf('%064d', 0), 'legado', 'revisao_humana', 'migrada da Fase 1', 'legado',
  confirmation, notes, applied_at, created_at, updated_at
FROM applications;

CREATE TABLE application_events_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications_new (id),
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  mode            TEXT NOT NULL,
  channel         TEXT,
  actor           TEXT NOT NULL CHECK (actor IN ('sistema', 'usuario')),
  -- Motivo curto e legível. Nunca guardar endereço de e-mail, corpo de mensagem ou credenciais.
  reason          TEXT NOT NULL CHECK (length(reason) > 0),
  -- Torna a mesma operação repetível sem duplicar o histórico (retentativa após falha).
  idempotency_key TEXT,
  created_at      TEXT NOT NULL
);

INSERT INTO application_events_new (
  id, application_id, from_status, to_status, mode, actor, reason, created_at
)
SELECT e.id, e.application_id, e.from_status, e.to_status, a.mode, 'sistema',
       COALESCE(e.detail, 'migrado da Fase 1'), e.created_at
FROM application_events e JOIN applications_new a ON a.id = e.application_id;

DROP TABLE application_events;
DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;
ALTER TABLE application_events_new RENAME TO application_events;

CREATE INDEX idx_applications_status ON applications (status);
CREATE INDEX idx_application_events_application ON application_events (application_id, id);
CREATE UNIQUE INDEX idx_application_events_idempotency
  ON application_events (application_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Histórico imutável: eventos só podem ser acrescentados.
CREATE TRIGGER application_events_no_update BEFORE UPDATE ON application_events
BEGIN SELECT RAISE(ABORT, 'application_events é imutável'); END;
CREATE TRIGGER application_events_no_delete BEFORE DELETE ON application_events
BEGIN SELECT RAISE(ABORT, 'application_events é imutável'); END;

-- Rede de segurança no banco: em dry-run nada pode estar em envio ou enviado.
CREATE TRIGGER applications_dry_run_never_sends BEFORE UPDATE ON applications
WHEN NEW.mode = 'dry-run' AND NEW.status IN ('enviando', 'enviada', 'entrega_confirmada')
BEGIN SELECT RAISE(ABORT, 'candidatura em dry-run não pode ser enviada'); END;
CREATE TRIGGER applications_dry_run_never_sends_insert BEFORE INSERT ON applications
WHEN NEW.mode = 'dry-run' AND NEW.status IN ('enviando', 'enviada', 'entrega_confirmada')
BEGIN SELECT RAISE(ABORT, 'candidatura em dry-run não pode ser enviada'); END;

-- A versão do currículo e a vaga de uma candidatura não mudam depois de criadas.
CREATE TRIGGER applications_identity_immutable BEFORE UPDATE OF job_id, cv_sha256, cv_label ON applications
WHEN NEW.job_id <> OLD.job_id OR NEW.cv_sha256 <> OLD.cv_sha256 OR NEW.cv_label <> OLD.cv_label
BEGIN SELECT RAISE(ABORT, 'vaga e currículo de uma candidatura são imutáveis'); END;
