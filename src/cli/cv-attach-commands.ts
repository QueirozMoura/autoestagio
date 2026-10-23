import type { Command } from 'commander';
import { loadConfig } from '../config/index.js';
import { listAttachments } from '../cv/attachments.js';
import type { StrictInputsOptions } from '../cv/strict-inputs.js';
import { getMigrationStatus, openDatabase, type Db } from '../db/index.js';
import {
  approveResumeLink,
  attachResume,
  formatAttachment,
  formatAttachmentList,
  revokeResumeLink,
  type AttachOutcome,
  type DecisionOutcome,
} from './cv-attach.js';

function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const db = openDatabase(loadConfig().databasePath);
  return (async () => {
    try {
      const { pending } = getMigrationStatus(db);
      if (pending.length > 0)
        throw new Error(`Há migrações pendentes (${pending.join(', ')}). Rode "migrate" antes.`);
      return await fn(db);
    } finally {
      db.close();
    }
  })();
}

function id(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} inválido: ${value}`);
  return n;
}

/** Subcomandos do vínculo candidatura↔currículo. Nenhum deles envia e-mail ou fala com o Gmail. */
export function registerCvAttachCommands(
  cv: Command,
  inputs: (anchorSha256: string | undefined) => StrictInputsOptions,
): void {
  const show = (outcome: AttachOutcome | DecisionOutcome, json?: boolean): void => {
    console.log(json === true ? JSON.stringify(outcome, null, 2) : formatAttachment(outcome));
    if (!outcome.ok) process.exitCode = 1;
  };

  cv.command('attach')
    .description(
      'Gera a variante pelo fluxo estrito (em memória), registra o artefato e cria o vínculo EM PREPARAÇÃO com a candidatura (não aprova nem envia)',
    )
    .requiredOption('--application <id>', 'candidatura (deve estar "preparada")')
    .option('--job <id>', 'confere que a candidatura é desta vaga')
    .option('--variant <id>', 'variante (obrigatória; a área da vaga só gera uma sugestão)')
    .option('--ancora-sha256 <hash>', 'SHA-256 do arquivo de âncora de confiança (obrigatório)')
    .option('--replace', 'substitui um vínculo EM PREPARAÇÃO (nunca um aprovado)')
    .option('--json', 'saída em JSON')
    .action(
      async (options: {
        application: string;
        job?: string;
        variant?: string;
        ancoraSha256?: string;
        replace?: boolean;
        json?: boolean;
      }) => {
        const outcome = await withDb((db) =>
          attachResume({
            db,
            applicationId: id(options.application, 'Candidatura'),
            ...(options.job === undefined ? {} : { jobId: id(options.job, 'Vaga') }),
            variant: options.variant,
            inputs: inputs(options.ancoraSha256),
            ...(options.replace === true ? { replace: true } : {}),
          }),
        );
        show(outcome, options.json);
      },
    );

  const link = cv
    .command('attachment')
    .description('Consulta, aprova e revoga o vínculo de currículo de uma candidatura');

  link
    .command('list <application>')
    .description('Histórico dos vínculos (sem caminhos nem hashes completos)')
    .option('--json', 'saída em JSON')
    .action(async (application: string, options: { json?: boolean }) => {
      const appId = id(application, 'Candidatura');
      const views = await withDb((db) => listAttachments(db, appId));
      console.log(
        options.json === true ? JSON.stringify(views, null, 2) : formatAttachmentList(views, appId),
      );
    });

  link
    .command('approve <application>')
    .description(
      'Aprova o vínculo (ação própria). Reverifica o PDF pela geração estrita. NÃO aprova a candidatura para envio',
    )
    .requiredOption('--sha8 <hex>', 'identificador (8 hex) do PDF vinculado, mostrado por "list"')
    .requiredOption('--reason <texto>', 'motivo da aprovação')
    .option('--ancora-sha256 <hash>', 'SHA-256 do arquivo de âncora de confiança (obrigatório)')
    .option('--json', 'saída em JSON')
    .action(
      async (
        application: string,
        options: { sha8: string; reason: string; ancoraSha256?: string; json?: boolean },
      ) => {
        const outcome = await withDb((db) =>
          approveResumeLink({
            db,
            applicationId: id(application, 'Candidatura'),
            confirmSha8: options.sha8,
            reason: options.reason,
            inputs: inputs(options.ancoraSha256),
          }),
        );
        show(outcome, options.json);
      },
    );

  link
    .command('revoke <application>')
    .description('Revoga o vínculo aprovado (definitivo; preserva o histórico)')
    .requiredOption('--sha8 <hex>', 'identificador (8 hex) do PDF vinculado, mostrado por "list"')
    .requiredOption('--reason <texto>', 'motivo da revogação')
    .option('--json', 'saída em JSON')
    .action(
      async (application: string, options: { sha8: string; reason: string; json?: boolean }) => {
        const outcome = await withDb((db) =>
          revokeResumeLink({
            db,
            applicationId: id(application, 'Candidatura'),
            confirmSha8: options.sha8,
            reason: options.reason,
          }),
        );
        show(outcome, options.json);
      },
    );
}
