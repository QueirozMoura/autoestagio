-- Etapa 2.4A: guarda a URL de candidatura informada pela fonte (ex.: `applyUrl` da Ashby).
-- Migração aditiva: coluna opcional, sem reconstruir tabelas; as linhas existentes ficam com NULL.
ALTER TABLE jobs ADD COLUMN apply_url TEXT;
