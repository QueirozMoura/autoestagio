#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigError, loadConfig } from '../config/index.js';
import { openDatabase, runMigrations } from '../db/index.js';
import { collectStatus, formatStatus } from './status.js';

const program = new Command();

program
  .name('autoestagio')
  .description('Encontra, analisa e gerencia candidaturas a estágios em TI.')
  .version('0.1.0');

program
  .command('status')
  .description('Mostra o estado da configuração, do perfil e do banco de dados')
  .option('--json', 'saída em JSON')
  .action((options: { json?: boolean }) => {
    const report = collectStatus(loadConfig());
    console.log(options.json ? JSON.stringify(report, null, 2) : formatStatus(report));
  });

program
  .command('migrate')
  .description('Cria o banco de dados (se necessário) e aplica as migrações pendentes')
  .action(() => {
    const config = loadConfig();
    const db = openDatabase(config.databasePath);
    try {
      const applied = runMigrations(db);
      console.log(
        applied.length > 0
          ? `Migrações aplicadas:\n${applied.map((name) => `  - ${name}`).join('\n')}`
          : 'Banco de dados já está atualizado.',
      );
    } finally {
      db.close();
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(`Erro: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
