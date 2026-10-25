import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { loadConfig } from '../config/index.js';
import type { Db } from '../db/index.js';
import { loadPolicy } from '../autonomy/index.js';
import {
  ApplicantError,
  ExecutorError,
  launchSession,
  loadApplicant,
  runExecutor,
  type ExecItemReport,
  type ExecRunReport,
} from '../executor/index.js';
import { resolveFromRoot } from '../utils/paths.js';
import { profileForRun } from './run-profile.js';

interface Deps {
  withDb: <T>(fn: (db: Db) => T) => T;
  withDbAsync: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
}

const STATE: Record<string, string> = {
  ok: 'ok',
  pulado: 'pulado',
  bloqueado: 'BLOQUEADO',
  falhou: 'FALHOU',
};

export function formatExecItem(item: ExecItemReport): string {
  const out: string[] = [
    `Fila #${item.queueId} — vaga ${item.jobId}: ${item.company ?? '?'} — ${item.title}`,
    `  link: ${item.url || '(não aberto)'}`,
    '  Etapas:',
    ...item.steps.map((s) => `    [${STATE[s.state] ?? s.state}] ${s.step}: ${s.detail}`),
  ];
  if (item.filled.length > 0)
    out.push(
      '  Preenchido (origem → valor; conferido na página):',
      ...item.filled.map(
        (f) =>
          `    ${f.ok ? '✔' : '✘'} ${f.label}: ${f.value}  ← ${f.source}${f.readBack !== '' && f.readBack !== f.value ? ` (a página mostra: ${f.readBack})` : ''}`,
      ),
    );
  else if (item.planned.length > 0)
    out.push(
      '  Preencheria (modo planejar):',
      ...item.planned.map((p) => `    • ${p.label}: ${p.value}  ← ${p.source}`),
    );
  if (item.needsHuman.length > 0)
    out.push(
      '  Depende de você:',
      ...item.needsHuman.map(
        (h) =>
          `    ${h.required ? '★ obrigatório' : '· opcional'} [${h.category}] ${h.label} — ${h.why}`,
      ),
    );
  if (item.skipped.length > 0)
    out.push(`  Opcionais deixados em branco: ${item.skipped.map((s) => s.label).join('; ')}`);
  if (item.cv !== null)
    out.push(`  Currículo: ${item.cv.label} (sha ${item.cv.sha8}; ${item.cv.note})`);
  if (item.screenshot !== null) out.push(`  Captura de tela: ${item.screenshot}`);
  if (item.evidence !== null) out.push(`  EVIDÊNCIA: ${item.evidence}`);
  out.push(
    `  Resultado: ${item.outcome}${item.notes.length > 0 ? ` — ${item.notes.join(' | ')}` : ''}`,
  );
  return out.join('\n');
}

export function formatExecRun(run: ExecRunReport): string {
  return [
    `Executor assistido (${run.mode === 'planejar' ? 'planejar: nada é preenchido' : 'preparar: preenche e para antes do envio'}) — ${run.items.length} vaga(s) processada(s); ainda prontas na fila: ${run.remainingReady}.`,
    ...run.items.map((i) => `\n${formatExecItem(i)}`),
    '\nO executor NUNCA envia a candidatura: o envio é seu. Itens preparados ficam "pendente_humano" na fila até haver evidência.',
  ].join('\n');
}

/** Executor assistido da fila: abre o link, identifica o formulário, preenche o que é comprovado e para antes do envio. */
export function registerExecCommand(cmd: Command, { withDbAsync }: Deps): void {
  cmd
    .command('exec')
    .description(
      'Executor assistido: prepara a próxima candidatura da fila no navegador e PARA antes do envio',
    )
    .option('--max <n>', 'quantas vagas processar', '1')
    .option('--item <id>', 'processa só este item da fila')
    .option(
      '--planejar',
      'só lê a página e mostra o que preencheria (nada é preenchido nem anexado)',
    )
    .option(
      '--com-janela',
      'abre a janela do Chrome (necessário para entrar na sua conta, como na Gupy)',
    )
    .option(
      '--revisar',
      'mantém a janela aberta para você revisar e enviar; depois procura a confirmação (implica --com-janela)',
    )
    .option('--json', 'saída em JSON')
    .action(
      async (options: {
        max: string;
        item?: string;
        planejar?: boolean;
        comJanela?: boolean;
        revisar?: boolean;
        json?: boolean;
      }) => {
        const config = loadConfig();
        const { profile } = profileForRun(config.profilePath);
        const policy = loadPolicy();
        try {
          const applicant = loadApplicant();
          const headed = options.comJanela === true || options.revisar === true;
          if (options.revisar === true && options.planejar === true)
            throw new ExecutorError('--revisar não combina com --planejar.');
          const session = await launchSession({
            profileDir: resolveFromRoot('data/browser-profile'),
            headless: !headed,
          });
          try {
            const run = await withDbAsync((db) =>
              runExecutor({
                db,
                profile,
                applicant,
                salary: policy.salaryExpectation.amount,
                session,
                mode: options.planejar === true ? 'planejar' : 'preparar',
                max: Math.max(1, Number(options.max) || 1),
                ...(options.item === undefined ? {} : { itemId: Number(options.item) }),
                outputDir: resolveFromRoot('data/exec'),
                cvDir: resolveFromRoot('data/cv-output'),
                ...(options.revisar === true
                  ? {
                      review: async (item: ExecItemReport) => {
                        console.log(`\n${formatExecItem(item)}`);
                        const rl = createInterface({
                          input: process.stdin,
                          output: process.stdout,
                        });
                        await rl.question(
                          '\nRevise a página na janela do Chrome. Se for candidatar, envie VOCÊ mesmo. Pressione Enter ao terminar... ',
                        );
                        rl.close();
                      },
                    }
                  : {}),
              }),
            );
            console.log(options.json === true ? JSON.stringify(run, null, 2) : formatExecRun(run));
          } finally {
            await session.close();
          }
        } catch (error) {
          if (error instanceof ApplicantError || error instanceof ExecutorError) {
            console.error(error.message);
            process.exitCode = 2;
            return;
          }
          throw error;
        }
      },
    );
}
