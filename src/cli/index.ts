#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigError, loadConfig } from '../config/index.js';
import { getMigrationStatus, openDatabase, runMigrations } from '../db/index.js';
import { runRealScan, runSimulation, type ScanReport } from '../discovery/index.js';
import { loadSourcesConfig } from '../sources/index.js';
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
  .description('Coleta vagas de estágio nas fontes configuradas, ou em modo simulado (--simulate)')
  .option('--simulate', 'usa fontes fictícias e dados de teste; nenhuma requisição é feita')
  .option(
    '--source <kind:slug...>',
    'limita a coleta real a estas fontes (ex.: greenhouse:agilize)',
  )
  .option(
    '--db-file <caminho>',
    'guarda o resultado simulado neste arquivo (padrão: só em memória)',
  )
  .option('--repeat <n>', 'repete a execução simulada n vezes, para conferir a idempotência', '1')
  .option('--json', 'saída em JSON')
  .action(
    async (options: {
      simulate?: boolean;
      source?: string[];
      dbFile?: string;
      repeat: string;
      json?: boolean;
    }) => {
      const config = loadConfig();
      let reports: ScanReport[];
      let footer: string;

      if (options.simulate === true) {
        reports = await runSimulation({
          dbFile: options.dbFile,
          protectedDbPath: config.databasePath,
          repeat: Number(options.repeat),
        });
        footer =
          options.dbFile === undefined
            ? 'Dados simulados mantidos apenas em memória; nada foi gravado em disco.'
            : `Resultado gravado em ${options.dbFile}.`;
      } else {
        const db = openDatabase(config.databasePath);
        try {
          const { pending } = getMigrationStatus(db);
          if (pending.length > 0) {
            throw new Error(
              `Há migrações pendentes (${pending.join(', ')}). Rode "migrate" antes do scan.`,
            );
          }
          reports = [await runRealScan({ db, config: loadSourcesConfig(), only: options.source })];
        } finally {
          db.close();
        }
        footer = `Vagas gravadas em ${config.databasePath}. Somente leitura nas plataformas; nada foi enviado.`;
      }

      if (options.json === true) {
        console.log(JSON.stringify(reports, null, 2));
        return;
      }
      console.log(
        reports.map((report, i) => formatScanReport(report, i, reports.length)).join('\n\n'),
      );
      console.log(`\n${footer}`);
      if (reports.every((report) => report.sources.every((source) => source.error !== null))) {
        process.exitCode = 1;
      }
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
