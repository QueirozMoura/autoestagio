#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import {
  ConfigError,
  loadConfig,
  loadProfile,
  verifyApprovedCv,
  type CvReference,
  type Profile,
} from '../config/index.js';
import {
  backupDatabase,
  backupPath,
  getMigrationStatus,
  openDatabase,
  runMigrations,
} from '../db/index.js';
import { runRealScan, runSimulation, type ScanReport } from '../discovery/index.js';
import {
  CHANNELS,
  STATUSES,
  type Channel,
  countByStatus,
  getApplication,
  getHistory,
  listApplications,
  recoverInterrupted,
  type Status,
} from '../applications/index.js';
import {
  addQuestion,
  answerRequirement,
  getPreparation,
  listCandidates,
  markReviewed,
  prepareApplication,
} from '../preparation/index.js';
import {
  analyzeJobs,
  profileHash,
  unknownProfileAreas,
  VERDICTS,
  type Verdict,
} from '../eligibility/index.js';
import { loadSourcesConfig } from '../sources/index.js';
import { formatAnalysis } from './analyze.js';
import { registerApplyCommands } from './apply-commands.js';
import { registerLeadCommands } from './leads.js';
import { registerLocationCommands } from './locais.js';
import { registerCvCommands } from './cv-commands.js';
import { registerEmailCommands } from './email-commands.js';
import { formatCandidates, formatPrepareResult, formatPreview } from './preparation.js';
import {
  formatApplication,
  formatApplicationList,
  formatCounts,
  formatHistory,
} from './applications.js';
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
  .description(
    'Cria o banco de dados (se necessário) e aplica as migrações pendentes (com backup verificado)',
  )
  .option('--no-backup', 'não faz backup antes de migrar (não recomendado)')
  .action(async (options: { backup: boolean }) => {
    const config = loadConfig();
    const db = openDatabase(config.databasePath);
    try {
      const status = getMigrationStatus(db);
      // Banco já em uso + migração pendente: backup verificado antes de qualquer alteração.
      if (options.backup && status.applied.length > 0 && status.pending.length > 0) {
        const target = backupPath(
          join(dirname(config.databasePath), 'backups'),
          `pre-${status.pending[0]?.slice(0, 4) ?? 'migracao'}`,
        );
        const result = await backupDatabase(db, target);
        console.log(
          `Backup verificado (${result.tables} tabelas, ${result.rows} linhas): ${result.path}`,
        );
      }
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
  .command('backup')
  .description('Faz um backup verificado do banco de dados (integridade e contagem de linhas)')
  .action(async () => {
    const config = loadConfig();
    const db = openDatabase(config.databasePath);
    try {
      const target = backupPath(join(dirname(config.databasePath), 'backups'), 'manual');
      const result = await backupDatabase(db, target);
      console.log(
        `Backup verificado (${result.tables} tabelas, ${result.rows} linhas): ${result.path}`,
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

program
  .command('analyze')
  .description(
    'Classifica as vagas gravadas em apto, inapto ou revisão humana (somente análise local)',
  )
  .option('--no-save', 'não grava o resultado no banco')
  .option('--verdict <veredito>', `mostra só este veredito (${VERDICTS.join(', ')})`)
  .option('--verbose', 'mostra todos os critérios avaliados')
  .option('--json', 'saída em JSON')
  .action((options: { save: boolean; verdict?: string; verbose?: boolean; json?: boolean }) => {
    const config = loadConfig();
    const loaded = loadProfile(config.profilePath);
    if (loaded === undefined) {
      throw new Error(
        `Perfil não encontrado em ${config.profilePath}. Veja config/profile.example.json.`,
      );
    }
    // A aprovação só vale se o currículo no disco for exatamente o aprovado (SHA-256).
    let profile = loaded;
    if (loaded.approval !== undefined) {
      const cv = verifyApprovedCv(loaded);
      if (!cv.ok) {
        console.warn(`Aviso: aprovação ignorada: ${cv.reason}.`);
        profile = { ...loaded, approval: undefined };
      }
    }
    const unknownAreas = unknownProfileAreas(loaded.areas);
    if (unknownAreas.length > 0)
      console.warn(
        `Aviso: áreas do perfil não reconhecidas (ignoradas): ${unknownAreas.join(', ')}.`,
      );
    if (
      options.verdict !== undefined &&
      !(VERDICTS as readonly string[]).includes(options.verdict)
    ) {
      throw new Error(`Veredito inválido: ${options.verdict}. Use ${VERDICTS.join(', ')}.`);
    }
    const db = openDatabase(config.databasePath);
    try {
      const { pending } = getMigrationStatus(db);
      if (pending.length > 0) {
        throw new Error(`Há migrações pendentes (${pending.join(', ')}). Rode "migrate" antes.`);
      }
      const report = analyzeJobs({ db, profile, save: options.save });
      const shown =
        options.verdict === undefined
          ? report
          : {
              ...report,
              jobs: report.jobs.filter(
                (job) => job.result.verdict === (options.verdict as Verdict),
              ),
            };
      console.log(
        options.json === true
          ? JSON.stringify(shown, null, 2)
          : formatAnalysis(shown, options.verbose === true),
      );
    } finally {
      db.close();
    }
  });

const applications = program
  .command('applications')
  .description('Consulta o histórico de candidaturas (somente leitura, sem dados sensíveis)');

function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  try {
    const { pending } = getMigrationStatus(db);
    if (pending.length > 0) {
      throw new Error(`Há migrações pendentes (${pending.join(', ')}). Rode "migrate" antes.`);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Identificador inválido: ${value}`);
  return id;
}

applications
  .command('list')
  .description('Lista as candidaturas')
  .option('--status <estado>', `filtra por estado (${STATUSES.join(', ')})`)
  .option('--json', 'saída em JSON')
  .action((options: { status?: string; json?: boolean }) => {
    if (options.status !== undefined && !(STATUSES as readonly string[]).includes(options.status)) {
      throw new Error(`Estado inválido: ${options.status}. Use ${STATUSES.join(', ')}.`);
    }
    const items = withDb((db) =>
      listApplications(
        db,
        options.status === undefined ? {} : { status: options.status as Status },
      ),
    );
    console.log(
      options.json === true ? JSON.stringify(items, null, 2) : formatApplicationList(items),
    );
  });

applications
  .command('show <id>')
  .description('Mostra uma candidatura')
  .option('--json', 'saída em JSON')
  .action((id: string, options: { json?: boolean }) => {
    const application = withDb((db) => getApplication(db, parseId(id)));
    if (application === undefined) throw new Error(`Candidatura ${id} não encontrada.`);
    console.log(
      options.json === true ? JSON.stringify(application, null, 2) : formatApplication(application),
    );
  });

applications
  .command('history <id>')
  .description('Mostra o histórico de transições (data, canal e motivo)')
  .option('--json', 'saída em JSON')
  .action((id: string, options: { json?: boolean }) => {
    const events = withDb((db) => getHistory(db, parseId(id)));
    console.log(options.json === true ? JSON.stringify(events, null, 2) : formatHistory(events));
  });

applications
  .command('stats')
  .description('Conta as candidaturas por estado')
  .option('--json', 'saída em JSON')
  .action((options: { json?: boolean }) => {
    const counts = withDb((db) => countByStatus(db));
    console.log(options.json === true ? JSON.stringify(counts, null, 2) : formatCounts(counts));
  });

applications
  .command('recover')
  .description('Move para intervenção humana os envios interrompidos (nunca reenvia)')
  .option(
    '--older-than-min <min>',
    'considera interrompidos os envios parados há mais de n minutos',
    '15',
  )
  .action((options: { olderThanMin: string }) => {
    const minutes = Number(options.olderThanMin);
    if (!Number.isFinite(minutes) || minutes < 0)
      throw new Error('Valor inválido para --older-than-min.');
    const ids = withDb((db) => recoverInterrupted(db, { olderThanMs: minutes * 60_000 }));
    console.log(
      ids.length === 0
        ? 'Nenhum envio interrompido.'
        : `Movidas para intervenção humana: ${ids.map((id) => `#${id}`).join(', ')}.`,
    );
  });

/** Perfil aprovado + currículo conferido pelo SHA-256; sem isso nada é preparado. */
function approvedContext(): { profile: Profile; cv: CvReference } {
  const profile = loadProfile(loadConfig().profilePath);
  if (profile === undefined)
    throw new Error('Perfil não encontrado. Veja config/profile.example.json.');
  if (profile.approval === undefined)
    throw new Error('O perfil ainda não foi aprovado (approval ausente).');
  const cv = verifyApprovedCv(profile);
  if (!cv.ok) throw new Error(`Currículo não confere com o aprovado: ${cv.reason}.`);
  return { profile, cv: cv.cv };
}

applications
  .command('candidates')
  .description(
    'Lista vagas elegíveis (aptas ou em revisão) sem candidatura, em ordem transparente (a área não pesa)',
  )
  .option('--explain', 'mostra por que cada vaga ficou nesta posição')
  .action((options: { explain?: boolean }) => {
    const { profile } = approvedContext();
    console.log(
      formatCandidates(
        withDb((db) => listCandidates(db, profileHash(profile))),
        options.explain === true,
      ),
    );
  });

applications
  .command('prepare <vaga>')
  .description('Prepara a candidatura de uma vaga em dry-run (gera o rascunho; nada é enviado)')
  .option('--channel <canal>', `canal previsto (${CHANNELS.join(', ')})`)
  .option('--override-review <motivo>', 'decisão sua de preparar uma vaga em revisão humana')
  .option(
    '--acknowledge-equivalent <motivo>',
    'confirma que a vaga equivalente já candidatada é outra',
  )
  .option('--regenerate', 'refaz um rascunho desatualizado')
  .action(
    (
      vaga: string,
      options: {
        channel?: string;
        overrideReview?: string;
        acknowledgeEquivalent?: string;
        regenerate?: boolean;
      },
    ) => {
      if (
        options.channel !== undefined &&
        !(CHANNELS as readonly string[]).includes(options.channel)
      ) {
        throw new Error(`Canal inválido: ${options.channel}. Use ${CHANNELS.join(', ')}.`);
      }
      const { profile, cv } = approvedContext();
      const result = withDb((db) =>
        prepareApplication(db, {
          profile,
          cv,
          jobId: parseId(vaga),
          ...(options.channel === undefined ? {} : { channel: options.channel as Channel }),
          ...(options.overrideReview === undefined
            ? {}
            : { reviewOverride: { reason: options.overrideReview } }),
          ...(options.acknowledgeEquivalent === undefined
            ? {}
            : { acknowledgeEquivalent: { reason: options.acknowledgeEquivalent } }),
          ...(options.regenerate === true ? { regenerate: true } : {}),
        }),
      );
      console.log(formatPrepareResult(result));
      if (result.outcome === 'recusada') process.exitCode = 1;
    },
  );

applications
  .command('preview <id>')
  .alias('review')
  .description('Mostra a mensagem preparada, a origem de cada afirmação e as pendências')
  .option('--show-answers', 'mostra também as respostas registradas')
  .option('--json', 'saída em JSON')
  .action((id: string, options: { showAnswers?: boolean; json?: boolean }) => {
    const { profile } = approvedContext();
    const view = withDb((db) =>
      getPreparation(db, parseId(id), {
        profileHash: profileHash(profile),
        showAnswers: options.showAnswers === true,
      }),
    );
    if (view === undefined) throw new Error(`Candidatura ${id} não encontrada.`);
    console.log(options.json === true ? JSON.stringify(view, null, 2) : formatPreview(view));
  });

applications
  .command('add-question <id> <pergunta>')
  .description(
    'Registra uma pergunta de formulário: só o perfil aprovado responde o que sabe; o resto fica pendente',
  )
  .action((id: string, pergunta: string) => {
    const { profile } = approvedContext();
    const result = withDb((db) => addQuestion(db, parseId(id), profile, pergunta));
    console.log(
      result.answered
        ? `Pergunta ${result.key}: respondida com o perfil aprovado.`
        : `Pergunta ${result.key}: PENDENTE (nenhuma resposta foi inventada). Responda com "applications answer".`,
    );
  });

applications
  .command('answer <id> <chave>')
  .description('Você responde uma pendência')
  .requiredOption('--text <texto>', 'a resposta')
  .action((id: string, chave: string, options: { text: string }) => {
    withDb((db) => {
      answerRequirement(db, parseId(id), chave, options.text);
    });
    console.log(`Pendência ${chave} respondida.`);
  });

applications
  .command('confirm-review <id>')
  .description('Confirma que você revisou este rascunho (não aprova o envio)')
  .action((id: string) => {
    const { profile } = approvedContext();
    withDb((db) => {
      markReviewed(db, parseId(id), profileHash(profile));
    });
    console.log(
      `Rascunho da candidatura #${id} marcado como revisado. Ainda NÃO está aprovado para envio.`,
    );
  });

async function withDbAsync<T>(fn: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
  const db = openDatabase(loadConfig().databasePath);
  try {
    const { pending } = getMigrationStatus(db);
    if (pending.length > 0) {
      throw new Error(`Há migrações pendentes (${pending.join(', ')}). Rode "migrate" antes.`);
    }
    return await fn(db);
  } finally {
    db.close();
  }
}

registerEmailCommands(program, { withDb, withDbAsync, parseId });
registerCvCommands(program);
registerApplyCommands(program, { withDbAsync, parseId });
registerLocationCommands(program, { withDb });
registerLeadCommands(program, { withDb, parseId });

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
