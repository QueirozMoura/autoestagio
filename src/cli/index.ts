#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigError, loadConfig } from '../config/index.js';
import { runSimulation } from '../discovery/index.js';
import { openDatabase, runMigrations } from '../db/index.js';
import { formatScanReport } from './scan.js';
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

program
  .command('scan')
  .description('Coleta vagas. Nesta etapa só existe o modo simulado (fontes fictícias, sem rede)')
  .option('--simulate', 'usa fontes fictícias e dados de teste; nenhuma requisição é feita')
  .option(
    '--db-file <caminho>',
    'guarda o resultado simulado neste arquivo (padrão: só em memória)',
  )
  .option('--repeat <n>', 'repete a execução n vezes, para conferir a idempotência', '1')
  .option('--json', 'saída em JSON')
  .action(
    async (options: { simulate?: boolean; dbFile?: string; repeat: string; json?: boolean }) => {
      if (options.simulate !== true) {
        throw new Error(
          'Fontes reais ainda não foram implementadas. Use "scan --simulate" para o modo simulado.',
        );
      }
      const config = loadConfig();
      const reports = await runSimulation({
        dbFile: options.dbFile,
        protectedDbPath: config.databasePath,
        repeat: Number(options.repeat),
      });
      if (options.json === true) {
        console.log(JSON.stringify(reports, null, 2));
        return;
      }
      console.log(
        reports.map((report, i) => formatScanReport(report, i, reports.length)).join('\n\n'),
      );
      console.log(
        options.dbFile === undefined
          ? '\nDados simulados mantidos apenas em memória; nada foi gravado em disco.'
          : `\nResultado gravado em ${options.dbFile}.`,
      );
    },
  );

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
