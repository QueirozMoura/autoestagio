import type { Command } from 'commander';
import { applyStatus, formatApplyStatus } from '../apply/status.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import type { Db } from '../db/index.js';
import { buildContext, contextWithAttachment, loadApproved } from './email-commands.js';

interface Deps {
  withDbAsync: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  parseId: (value: string) => number;
}

/** Visão de ponta a ponta de uma candidatura. Somente leitura; mostra dados mascarados. */
export function registerApplyCommands(program: Command, { withDbAsync, parseId }: Deps): void {
  const apply = program
    .command('apply')
    .description('Andamento da candidatura de ponta a ponta (somente leitura; nunca envia nada)');

  apply
    .command('status [candidatura]')
    .description(
      'Mostra cada etapa (elegibilidade, revisão, destinatário, currículo, teste, autorização) e a próxima ação',
    )
    .option(
      '--job <vaga>',
      'identifica a candidatura (ou a vaga, se ainda não houver candidatura) pela vaga',
    )
    .option(
      '--ancora-sha256 <hash>',
      'SHA-256 do arquivo de âncora (necessário só para verificar um currículo personalizado aprovado)',
    )
    .option('--json', 'saída em JSON (dados mascarados)')
    .action(
      async (
        candidatura: string | undefined,
        options: { job?: string; ancoraSha256?: string; json?: boolean },
      ) => {
        if ((candidatura === undefined) === (options.job === undefined))
          throw new Error('Informe a candidatura OU --job <vaga> (exatamente um).');
        const config: AppConfig = loadConfig();
        const status = await withDbAsync(async (db) => {
          const target =
            candidatura !== undefined
              ? { applicationId: parseId(candidatura) }
              : { jobId: parseId(options.job ?? '') };
          const existing =
            'applicationId' in target
              ? target.applicationId
              : (
                  db.prepare('SELECT id FROM applications WHERE job_id = ?').get(target.jobId) as
                    { id: number } | undefined
                )?.id;
          const ctx =
            existing === undefined
              ? buildContext(db, config, loadApproved(config))
              : await contextWithAttachment(db, config, existing, options.ancoraSha256);
          return applyStatus(ctx, target);
        });
        console.log(
          options.json === true ? JSON.stringify(status, null, 2) : formatApplyStatus(status),
        );
      },
    );
}
