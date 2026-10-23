-- Etapa 4.5a: registro de artefatos de currículo estritamente validados e vínculo com candidaturas.
-- Migração ADITIVA: só cria tabelas, índices e gatilhos novos. Nenhuma tabela existente é alterada,
-- nenhuma candidatura antiga é preenchida ou migrada, e a identidade original da candidatura
-- (applications.cv_sha256 / cv_label, o currículo mestre aprovado) permanece intacta.
--
-- IMPORTANTE: um registro aqui NÃO prova que o PDF ainda está íntegro ou aprovado. Ele só diz o que
-- foi atestado no momento da geração. Antes de qualquer uso, o PDF precisa ser reverificado pelo fluxo
-- estrito (hash do PDF, hash do modelo aprovado, vaga e variante). Os bytes do PDF NÃO ficam no banco.

CREATE TABLE cv_artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  variant      TEXT NOT NULL
                 CHECK (variant IN ('generico', 'desenvolvimento', 'qa', 'infraestrutura', 'banco-de-dados')),
  -- SHA-256 completo do PDF atestado (hex minúsculo).
  pdf_sha256   TEXT NOT NULL
                 CHECK (length(pdf_sha256) = 64 AND pdf_sha256 NOT GLOB '*[^0-9a-f]*'),
  pdf_bytes    INTEGER NOT NULL CHECK (pdf_bytes > 0 AND pdf_bytes <= 16777216),
  pages        INTEGER NOT NULL CHECK (pages BETWEEN 1 AND 10),
  -- Hash do modelo editorial aprovado usado na geração (não o conteúdo).
  model_hash   TEXT NOT NULL
                 CHECK (length(model_hash) = 64 AND model_hash NOT GLOB '*[^0-9a-f]*'),
  generated_at TEXT NOT NULL
                 CHECK (generated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  -- Só se registra o que passou pela validação estrita completa; outro valor exigiria nova migração.
  validation   TEXT NOT NULL CHECK (validation = 'estrita-completa'),
  -- Somente o NOME dentro do diretório de saída, no formato gerado pela aplicação
  -- (curriculo-<variante>-<AAAAMMDD>-<sha8>.pdf). Nunca um caminho; nada pessoal.
  file_name    TEXT NOT NULL
                 CHECK (file_name GLOB 'curriculo-' || variant || '-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-' || substr(pdf_sha256, 1, 8) || '.pdf'),
  -- O mesmo PDF da mesma variante e do mesmo modelo é registrado uma única vez.
  UNIQUE (variant, pdf_sha256, model_hash),
  UNIQUE (file_name)
);

CREATE TRIGGER cv_artifacts_no_update BEFORE UPDATE ON cv_artifacts
BEGIN SELECT RAISE(ABORT, 'cv_artifacts é imutável'); END;
CREATE TRIGGER cv_artifacts_no_delete BEFORE DELETE ON cv_artifacts
BEGIN SELECT RAISE(ABORT, 'cv_artifacts é imutável'); END;

-- Vínculo entre uma candidatura e um artefato. Estados (cada um com significado próprio):
--   em_preparacao: vínculo provisório, ainda NÃO aprovado; pode ser substituído (vira `substituido`);
--   aprovado:      o proprietário aprovou ESTE artefato para ESTA candidatura (não autoriza envio);
--   revogado:      um vínculo aprovado foi revogado de forma explícita, com motivo (terminal);
--   substituido:   um vínculo provisório trocado antes da aprovação (terminal).
-- Há no máximo UM vínculo vivo (em_preparacao ou aprovado) por candidatura. Um vínculo revogado ou
-- substituído nunca volta a valer: um novo vínculo exige nova seleção e nova aprovação.
-- Nenhuma linha é apagada: o histórico é preservado integralmente.
CREATE TABLE application_cv_attachments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id    INTEGER NOT NULL REFERENCES applications (id),
  -- Vaga redundante de propósito: permite conferir vaga e variante sem depender de outras tabelas.
  job_id            INTEGER NOT NULL REFERENCES jobs (id),
  artifact_id       INTEGER NOT NULL REFERENCES cv_artifacts (id),
  variant           TEXT NOT NULL
                      CHECK (variant IN ('generico', 'desenvolvimento', 'qa', 'infraestrutura', 'banco-de-dados')),
  state             TEXT NOT NULL DEFAULT 'em_preparacao'
                      CHECK (state IN ('em_preparacao', 'aprovado', 'revogado', 'substituido')),
  created_at        TEXT NOT NULL
                      CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  approved_at       TEXT,
  approval_reason   TEXT,
  revoked_at        TEXT,
  revocation_reason TEXT,
  superseded_at     TEXT,
  -- Datas e motivos coerentes com o estado. Um vínculo revogado já foi aprovado antes.
  CHECK ((state IN ('aprovado', 'revogado')) = (approved_at IS NOT NULL)),
  CHECK ((approved_at IS NULL) = (approval_reason IS NULL)),
  CHECK (approval_reason IS NULL OR length(trim(approval_reason)) BETWEEN 1 AND 300),
  CHECK ((state = 'revogado') = (revoked_at IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
  CHECK (revocation_reason IS NULL OR length(trim(revocation_reason)) BETWEEN 1 AND 300),
  CHECK ((state = 'substituido') = (superseded_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_cv_attachments_one_live
  ON application_cv_attachments (application_id)
  WHERE state IN ('em_preparacao', 'aprovado');
CREATE INDEX idx_cv_attachments_application ON application_cv_attachments (application_id);
CREATE INDEX idx_cv_attachments_artifact ON application_cv_attachments (artifact_id);
CREATE INDEX idx_cv_attachments_job ON application_cv_attachments (job_id);

-- Criação: sempre provisória, para uma candidatura "preparada" da MESMA vaga e um artefato da MESMA variante.
CREATE TRIGGER cv_attachments_insert_state BEFORE INSERT ON application_cv_attachments
WHEN NEW.state <> 'em_preparacao'
BEGIN SELECT RAISE(ABORT, 'o vínculo nasce em_preparacao'); END;

CREATE TRIGGER cv_attachments_insert_application BEFORE INSERT ON application_cv_attachments
WHEN NOT EXISTS (
  SELECT 1 FROM applications
  WHERE id = NEW.application_id AND job_id = NEW.job_id AND status = 'preparada'
)
BEGIN SELECT RAISE(ABORT, 'candidatura inexistente, de outra vaga ou fora do estado preparada'); END;

CREATE TRIGGER cv_attachments_insert_artifact BEFORE INSERT ON application_cv_attachments
WHEN NOT EXISTS (SELECT 1 FROM cv_artifacts WHERE id = NEW.artifact_id AND variant = NEW.variant)
BEGIN SELECT RAISE(ABORT, 'artefato inexistente ou de outra variante'); END;

-- Atualização: a identidade do vínculo nunca muda; vínculos revogados e substituídos são definitivos.
CREATE TRIGGER cv_attachments_identity_immutable
BEFORE UPDATE OF application_id, job_id, artifact_id, variant, created_at ON application_cv_attachments
WHEN NEW.application_id <> OLD.application_id OR NEW.job_id <> OLD.job_id
  OR NEW.artifact_id <> OLD.artifact_id OR NEW.variant <> OLD.variant OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'candidatura, vaga, artefato e variante do vínculo são imutáveis'); END;

CREATE TRIGGER cv_attachments_terminal BEFORE UPDATE ON application_cv_attachments
WHEN OLD.state IN ('revogado', 'substituido')
BEGIN SELECT RAISE(ABORT, 'vínculo revogado ou substituído é definitivo'); END;

-- A aprovação (data e motivo), uma vez dada, não muda: só pode ser seguida de revogação explícita.
CREATE TRIGGER cv_attachments_approval_immutable BEFORE UPDATE ON application_cv_attachments
WHEN OLD.approved_at IS NOT NULL
  AND (NEW.approved_at IS NOT OLD.approved_at OR NEW.approval_reason IS NOT OLD.approval_reason)
BEGIN SELECT RAISE(ABORT, 'a aprovação do vínculo não pode ser alterada'); END;

CREATE TRIGGER cv_attachments_transition_preparing BEFORE UPDATE ON application_cv_attachments
WHEN OLD.state = 'em_preparacao' AND NEW.state NOT IN ('aprovado', 'substituido')
BEGIN SELECT RAISE(ABORT, 'um vínculo em_preparacao só pode ser aprovado ou substituído'); END;

CREATE TRIGGER cv_attachments_transition_approved BEFORE UPDATE ON application_cv_attachments
WHEN OLD.state = 'aprovado' AND NEW.state <> 'revogado'
BEGIN SELECT RAISE(ABORT, 'um vínculo aprovado só pode ser revogado'); END;

CREATE TRIGGER cv_attachments_approve BEFORE UPDATE ON application_cv_attachments
WHEN OLD.state = 'em_preparacao' AND NEW.state = 'aprovado'
  AND NOT EXISTS (
    SELECT 1 FROM applications
    WHERE id = OLD.application_id AND status IN ('preparada', 'aprovada_para_envio')
  )
BEGIN SELECT RAISE(ABORT, 'só se aprova o vínculo de candidatura preparada ou aprovada para envio'); END;

CREATE TRIGGER cv_attachments_supersede BEFORE UPDATE ON application_cv_attachments
WHEN OLD.state = 'em_preparacao' AND NEW.state = 'substituido'
  AND NOT EXISTS (SELECT 1 FROM applications WHERE id = OLD.application_id AND status = 'preparada')
BEGIN SELECT RAISE(ABORT, 'só se substitui o vínculo de candidatura ainda preparada'); END;

-- Revogação: não se revoga o currículo de uma candidatura que já foi (ou pode ter sido) enviada;
-- o anexo enviado é um fato histórico.
CREATE TRIGGER cv_attachments_revoke BEFORE UPDATE ON application_cv_attachments
WHEN OLD.state = 'aprovado' AND NEW.state = 'revogado'
  AND NOT EXISTS (
    SELECT 1 FROM applications
    WHERE id = OLD.application_id AND status IN ('preparada', 'aprovada_para_envio', 'falhou')
  )
BEGIN SELECT RAISE(ABORT, 'não se revoga o vínculo de candidatura já enviada ou em intervenção humana'); END;

-- Histórico: nenhum vínculo é apagado.
CREATE TRIGGER cv_attachments_no_delete BEFORE DELETE ON application_cv_attachments
BEGIN SELECT RAISE(ABORT, 'application_cv_attachments não pode ser apagado'); END;

-- Autorizações de envio (e-mail) ainda NÃO usadas valem para o anexo que existia quando foram dadas.
-- Qualquer mudança no vínculo da candidatura (criação, aprovação, revogação, substituição) as vence na
-- hora. O envio já exige `expires_at` futuro (src/email/send.ts); autorizações usadas não são tocadas.
CREATE TRIGGER cv_attachments_expire_authorizations_insert AFTER INSERT ON application_cv_attachments
BEGIN
  UPDATE email_authorizations SET expires_at = NEW.created_at
  WHERE application_id = NEW.application_id AND used_at IS NULL AND expires_at > NEW.created_at;
END;

CREATE TRIGGER cv_attachments_expire_authorizations_update AFTER UPDATE OF state ON application_cv_attachments
BEGIN
  UPDATE email_authorizations
  SET expires_at = COALESCE(NEW.revoked_at, NEW.superseded_at, NEW.approved_at, NEW.created_at)
  WHERE application_id = NEW.application_id AND used_at IS NULL
    AND expires_at > COALESCE(NEW.revoked_at, NEW.superseded_at, NEW.approved_at, NEW.created_at);
END;
