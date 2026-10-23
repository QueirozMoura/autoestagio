-- Etapa 4.6: evidência persistida de envio de TESTE bem-sucedido, exigida antes do envio real.
-- Migração ADITIVA: só acrescenta uma coluna e gatilhos a email_dispatches. Nenhuma linha existente
-- é alterada (a coluna nasce NULL) e o envio de teste continua indo apenas para a caixa de teste.
--
-- `intended_binding_hash`: no momento do envio de TESTE, o bindingHash que o envio REAL equivalente teria
-- (candidatura, conteúdo aprovado, identidade do anexo/vínculo e o destinatário real pretendido). O envio real
-- só passa se existir um teste ACEITO com exatamente esse valor; qualquer mudança relevante altera o hash e
-- invalida a evidência. Dry-run e exportação .eml não geram evidência: só uma linha de despacho `teste`.

ALTER TABLE email_dispatches
  ADD COLUMN intended_binding_hash TEXT
  CHECK (intended_binding_hash IS NULL OR (length(intended_binding_hash) = 64 AND intended_binding_hash NOT GLOB '*[^0-9a-f]*'));

CREATE TRIGGER email_dispatches_evidence_only_test BEFORE INSERT ON email_dispatches
WHEN NEW.intended_binding_hash IS NOT NULL AND NEW.kind <> 'teste'
BEGIN SELECT RAISE(ABORT, 'só um envio de teste carrega evidência do envio real pretendido'); END;

CREATE TRIGGER email_dispatches_evidence_immutable BEFORE UPDATE OF intended_binding_hash, kind, application_id ON email_dispatches
WHEN OLD.intended_binding_hash IS NOT NULL
  AND (NEW.intended_binding_hash IS NOT OLD.intended_binding_hash
       OR NEW.kind <> OLD.kind OR NEW.application_id <> OLD.application_id)
BEGIN SELECT RAISE(ABORT, 'a evidência de teste é imutável'); END;

CREATE TRIGGER email_dispatches_evidence_not_added BEFORE UPDATE OF intended_binding_hash ON email_dispatches
WHEN OLD.intended_binding_hash IS NULL AND NEW.intended_binding_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a evidência de teste só é gravada na criação do envio'); END;
