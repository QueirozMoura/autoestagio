import { existsSync } from 'node:fs';
import type { AppConfig } from '../config/index.js';
import { loadProfile, type Profile } from '../config/index.js';
import { getMigrationStatus, openDatabase, type MigrationStatus } from '../db/index.js';

export interface StatusReport {
  node: string;
  applyMode: AppConfig['applyMode'];
  autoApplyEnabled: boolean;
  maxApplicationsPerDay: number;
  profile: { path: string; loaded: boolean; name?: string };
  database: { path: string; exists: boolean; migrations?: MigrationStatus };
}

/** Coleta o estado do sistema sem criar nem alterar arquivos. */
export function collectStatus(config: AppConfig): StatusReport {
  const profile: Profile | undefined = loadProfile(config.profilePath);

  const database: StatusReport['database'] = {
    path: config.databasePath,
    exists: existsSync(config.databasePath),
  };
  if (database.exists) {
    const db = openDatabase(config.databasePath, { readonly: true });
    try {
      database.migrations = getMigrationStatus(db);
    } finally {
      db.close();
    }
  }

  return {
    node: process.version,
    applyMode: config.applyMode,
    autoApplyEnabled: config.applyMode === 'auto' && config.allowAutoApply,
    maxApplicationsPerDay: config.maxApplicationsPerDay,
    profile: {
      path: config.profilePath,
      loaded: profile !== undefined,
      ...(profile && { name: profile.name }),
    },
    database,
  };
}

export function formatStatus(report: StatusReport): string {
  const { database, profile } = report;
  const migrations = database.migrations;
  const dbLine = !database.exists
    ? 'não criado (execute "migrate")'
    : migrations && migrations.pending.length > 0
      ? `${migrations.applied.length} migração(ões) aplicada(s), ${migrations.pending.length} pendente(s)`
      : `atualizado (${migrations?.applied.length ?? 0} migração(ões) aplicada(s))`;

  return [
    'AutoEstágio — status',
    `  Node.js:            ${report.node}`,
    `  Modo de candidatura: ${report.applyMode}${report.autoApplyEnabled ? '' : ' (auto desabilitado)'}`,
    `  Limite diário:      ${report.maxApplicationsPerDay}`,
    `  Perfil:             ${profile.loaded ? `carregado (${profile.name ?? ''})` : 'não encontrado'}`,
    `  Banco de dados:     ${dbLine}`,
    `    ${database.path}`,
  ].join('\n');
}
