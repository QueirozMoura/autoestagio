import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { loadConfig, verifyApprovedCv } from '../config/index.js';
import type { Db } from '../db/index.js';
import {
  GrantError,
  QUEUE_STATUSES,
  QueueError,
  RunRefused,
  buildQueue,
  createGrant,
  classifyOpportunities,
  diagnose,
  extractionCauses,
  latestGrant,
  listGrants,
  listQueue,
  listRuns,
  loadPolicy,
  previewGrant,
  realAuthorization,
  revokeGrant,
  setQueueStatus,
  runAutonomous,
  runDecisions,
  sourceMetrics,
  summarizeOpportunities,
  type Bucket,
  type DecisionLine,
  type QueueStatus,
  type DiscoverySummary,
  type RunReport,
} from '../autonomy/index.js';
import { runRealScan } from '../discovery/real-scan.js';
import { buildContext } from './email-commands.js';
import { registerExecCommand } from './exec.js';
import { profileForRun } from './run-profile.js';
import { loadSourcesConfig } from '../sources/index.js';
import { PROJECT_ROOT, resolveFromRoot } from '../utils/paths.js';

interface Deps {
  withDb: <T>(fn: (db: Db) => T) => T;
  withDbAsync: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
}

export const STOP_FILE = resolveFromRoot('data/autonomo.STOP');

const LABELS: Record<string, string> = {
  candidatar: 'CANDIDATARIA (simulação)',
  pendente: 'pendente',
  pendente_canal: 'pendente de canal (candidatura manual)',
  descartada: 'descartada',
  ja_candidatada: 'já candidatada',
  limite_atingido: 'limite atingido',
  enviada: 'ENVIADA',
  envio_incerto: 'ENVIO INCERTO (confira; nunca é reenviada)',
};

const BUCKET_LABELS: Record<Bucket, string> = {
  automatizavel: 'PRONTA para candidatura AUTOMÁTICA',
  manual: 'PRONTA para candidatura ASSISTIDA',
  insuficiente: 'PENDENTE de informações',
  incompativel: 'DESCARTADA (incompatível)',
};

const bucketLine = (b: Record<Bucket, number>): string =>
  (Object.keys(BUCKET_LABELS) as Bucket[]).map((k) => `${BUCKET_LABELS[k]}: ${b[k]}`).join('; ');

const line = (d: DecisionLine): string =>
  `  vaga ${d.jobId} [${LABELS[d.decision] ?? d.decision}] ${d.company ?? '?'} — ${d.title}\n` +
  `      ${d.reasons.join(' | ')}` +
  (d.connector === undefined ? '' : `\n      canal: ${d.connector}`) +
  (d.cvVariant === undefined ? '' : `; currículo: variante "${d.cvVariant}"`) +
  (d.evidence === undefined ? '' : `\n      evidência: ${d.evidence}`);

export function formatRunReport(report: RunReport): string {
  const out: string[] = [
    `Execução autônoma #${report.runId} (${report.mode === 'real' ? 'REAL' : 'simulação: nada é enviado'}) — ${report.status}`,
  ];
  if (report.discovery !== null)
    out.push(
      `Coleta: ${report.discovery.newJobs} vaga(s) nova(s), ${report.discovery.updatedJobs} atualizada(s).`,
    );
  out.push(
    `Novas nesta execução: ${report.fresh.total} vaga(s) — em TI: ${report.fresh.inIt}; aptas: ${report.fresh.apto}; pendentes: ${report.fresh.pendente}; descartadas: ${report.fresh.descartada}; com canal automatizável (e-mail): ${report.fresh.automatable}.`,
    `Categorias (todas as ${report.opportunities.total} vagas sem candidatura): ${bucketLine(report.opportunities.buckets)}.`,
    `Fila: ${report.queue.created} nova(s), ${report.queue.updated} atualizada(s), ${report.queue.cancelled} cancelada(s); prontas agora: ${report.queue.ready.automatico} automática(s) e ${report.queue.ready.assistido} assistida(s).`,
    `Análise: ${report.analyzed} vaga(s) — ${Object.entries(report.verdicts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')}; já com candidatura: ${report.alreadyApplied}.`,
    `Limites: ${report.limits.perRun} por execução, ${report.limits.perDay} por dia (hoje: ${report.limits.sentToday} enviada(s)); efetivo agora: ${report.limits.effective}.`,
    `Decisões: ${
      Object.entries(report.counts)
        .map(([k, v]) => `${LABELS[k] ?? k}: ${v}`)
        .join('; ') || 'nenhuma'
    }.`,
  );
  const show = (kind: string, title: string): void => {
    const rows = report.decisions.filter((d) => d.decision === kind);
    if (rows.length > 0) out.push('', `${title}:`, ...rows.map(line));
  };
  show('enviada', 'ENVIADAS (com evidência)');
  show('envio_incerto', 'ENVIO INCERTO (exigem sua conferência)');
  show('candidatar', 'Candidataria (dentro da política, com canal)');
  show('pendente_canal', 'Dentro da política, sem canal automático (candidatura manual)');
  show('pendente', 'Pendentes (precisam de informação ou de um portão resolvido)');
  show('limite_atingido', 'Acima do limite');
  if (report.opportunities.blockers.length > 0)
    out.push(
      '',
      'Principais bloqueios (vagas com informações insuficientes, por dado obrigatório que falta):',
      ...report.opportunities.blockers.map((b) => `  ${String(b.count).padStart(3)}× ${b.id}`),
    );
  if (report.discards.length > 0)
    out.push(
      '',
      'Motivos de descarte:',
      ...report.discards.map((d) => `  ${String(d.count).padStart(3)}× ${d.reason}`),
    );
  for (const note of report.notes) out.push('', note);
  if (report.errors.length > 0) out.push('', `Erros: ${report.errors.join('; ')}`);
  return out.join('\n');
}

/** Unidades de systemd (user) que rodam o pipeline sem nenhuma conversa aberta. Só SIMULAÇÃO por padrão. */
export function systemdUnits(options: { node: string; root: string; real?: boolean }): {
  service: string;
  timer: string;
} {
  const command = `autonomo run --trigger timer${options.real === true ? ' --real' : ''}`;
  return {
    service: `[Unit]
Description=AutoEstagio: execucao autonoma (${options.real === true ? 'REAL' : 'simulacao'})
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${options.root}
ExecStart=${options.node} --import tsx src/cli/index.ts ${command}
Nice=10
TimeoutStartSec=3h
`,
    timer: `[Unit]
Description=AutoEstagio: agenda da execucao autonoma

[Timer]
OnCalendar=*-*-* 02:30:00
OnCalendar=*-*-* 09:30:00
OnCalendar=*-*-* 15:30:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

const unitDir = (): string => join(homedir(), '.config', 'systemd', 'user');

/** Modo autônomo: opt-in, simulação por padrão, com trava de parada, limites e histórico no SQLite. */
export function registerAutonomoCommands(program: Command, { withDb, withDbAsync }: Deps): void {
  const cmd = program
    .command('autonomo')
    .description(
      'Modo autônomo: descoberta, análise, política e candidaturas (envio real só com concessão vigente)',
    );

  cmd
    .command('run')
    .description(
      'Executa o pipeline. Padrão: simulação (nada é enviado e nenhuma candidatura é criada)',
    )
    .option('--real', 'envio real: exige política ligada, real.authorized e uma concessão vigente')
    .option('--no-scan', 'não coleta vagas; usa as já gravadas')
    .option('--trigger <origem>', 'manual ou timer', 'manual')
    .option('--json', 'saída em JSON')
    .action(async (options: { real?: boolean; scan: boolean; trigger: string; json?: boolean }) => {
      if (options.trigger !== 'manual' && options.trigger !== 'timer')
        throw new Error('--trigger aceita "manual" ou "timer".');
      const config = loadConfig();
      const { profile, cvOk } = profileForRun(config.profilePath);
      const policy = loadPolicy();
      const discover = options.scan
        ? async (): Promise<DiscoverySummary> => {
            const report = await withDbAsync((db) =>
              runRealScan({ db, config: loadSourcesConfig() }),
            );
            return {
              newJobs: report.totals.new,
              updatedJobs: report.totals.updated,
              errors: report.sources.flatMap((source) =>
                source.error === null
                  ? []
                  : [`fonte ${source.source}: ${source.errorCategory ?? 'erro'}`],
              ),
            };
          }
        : undefined;
      try {
        const report = await withDbAsync((db) => {
          if (options.real === true && !cvOk)
            throw new RunRefused(
              'Envio real recusado: currículo aprovado ausente ou alterado no disco.',
            );
          const cv = profile.approval === undefined ? undefined : verifyApprovedCv(profile);
          return runAutonomous({
            db,
            profile,
            policy,
            mode: options.real === true ? 'real' : 'simulacao',
            trigger: options.trigger as 'manual' | 'timer',
            ...(discover === undefined ? {} : { discover }),
            ...(options.real === true && cv?.ok === true
              ? { emailContext: buildContext(db, config, profile), cv: cv.cv }
              : {}),
            stopFile: STOP_FILE,
            envMaxPerDay: config.maxApplicationsPerDay,
          });
        });
        console.log(
          options.json === true ? JSON.stringify(report, null, 2) : formatRunReport(report),
        );
        if (report.status === 'falhou') process.exitCode = 1;
      } catch (error) {
        if (error instanceof RunRefused) {
          console.error(error.message);
          process.exitCode = 2;
          return;
        }
        throw error;
      }
    });

  cmd
    .command('diagnose')
    .description(
      'Explica por que as vagas não são aptas: dados ausentes x incompatibilidade real (somente leitura)',
    )
    .option('--json', 'saída em JSON')
    .action((options: { json?: boolean }) => {
      const { profile } = profileForRun(loadConfig().profilePath);
      const result = withDb((db) => diagnose(db, profile));
      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const out = [
        `Vagas analisadas: ${result.total} — aptas: ${result.byClass.apta}; só com DADOS AUSENTES: ${result.byClass.dados_ausentes}; INCOMPATÍVEIS de fato: ${result.byClass.incompativel}.`,
        '',
        'Critérios obrigatórios que bloqueiam (vagas por critério):',
        ...Object.entries(result.byCriterion)
          .sort(
            (a, b) => b[1].nao_atende + b[1].indeterminado - (a[1].nao_atende + a[1].indeterminado),
          )
          .map(
            ([id, c]) => `  ${id}: reprovado em ${c.nao_atende}, sem dados em ${c.indeterminado}`,
          ),
        '',
        'Vagas só com dados ausentes, pelo conjunto do que falta:',
        ...result.missingSets.map((m) => `  ${m.jobs}× falta: ${m.missing.join(' + ')}`),
        '',
        'Causa das pendências de área, modalidade e bolsa (anúncio genérico x menção que o extrator não trata como regra):',
        ...withDb((db) => extractionCauses(db, profile)).flatMap((c) => [
          `  ${c.criterion}: ${c.pending} pendente(s) — ${c.generic} sem nenhuma menção (anúncio genérico), ${c.mentioned} com menção não declarativa`,
          ...c.samples.map((x) => `      #${x.jobId}: …${x.snippet}…`),
        ]),
        '',
        ...result.whatIf.map(
          (w) =>
            `Se "${w.tolerate.join(', ')}" desconhecido(a) fosse tolerado(a) (rules.tolerateUnknown), ${w.wouldBeApto} vaga(s) seriam aptas. Nada é relaxado sem a sua decisão.`,
        ),
      ];
      console.log(out.join('\n'));
    });

  cmd
    .command('sources')
    .description(
      'Métricas por fonte: vagas novas e relevantes que cada uma entrega (somente leitura)',
    )
    .option('--days <n>', 'janela em dias', '7')
    .option('--json', 'saída em JSON')
    .action((options: { days: string; json?: boolean }) => {
      const { profile } = profileForRun(loadConfig().profilePath);
      const days = Math.max(1, Number(options.days) || 7);
      const policy = loadPolicy();
      const { rows, summary } = withDb((db) => ({
        rows: sourceMetrics(db, profile, days),
        summary: summarizeOpportunities(classifyOpportunities(db, profile, policy)),
      }));
      const byBucket = new Map(summary.bySource.map((x) => [x.source, x.buckets]));
      if (options.json === true) {
        console.log(
          JSON.stringify(
            rows.map((m) => ({ ...m, categorias: byBucket.get(m.source) })),
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        [
          `Fontes (janela de ${days} dia(s)). autom. = elegível com e-mail utilizável; manual = elegível por formulário/portal; insuf. = faltam dados; incomp. = fora do perfil.`,
          'fonte                                    vagas  novas  emTI  autom.  manual  insuf.  incomp.  coletas(erros)',
          ...rows.map((m) => {
            const b = byBucket.get(m.source) ?? {
              automatizavel: 0,
              manual: 0,
              insuficiente: 0,
              incompativel: 0,
            };
            return `${m.source.padEnd(40)} ${String(m.jobs).padStart(5)} ${String(m.newInWindow).padStart(6)} ${String(m.inIt).padStart(5)} ${String(b.automatizavel).padStart(7)} ${String(b.manual).padStart(7)} ${String(b.insuficiente).padStart(7)} ${String(b.incompativel).padStart(8)}  ${m.runsInWindow}(${m.errorsInWindow})`;
          }),
        ].join('\n'),
      );
    });

  cmd
    .command('opportunities')
    .description(
      'Lista as vagas sem candidatura nas 4 categorias (automatizável, manual, insuficiente, incompatível)',
    )
    .option('--categoria <c>', 'automatizavel, manual, insuficiente ou incompativel')
    .option('--json', 'saída em JSON')
    .action((options: { categoria?: string; json?: boolean }) => {
      const { profile } = profileForRun(loadConfig().profilePath);
      const policy = loadPolicy();
      const list = withDb((db) => classifyOpportunities(db, profile, policy)).filter(
        (o) => options.categoria === undefined || o.bucket === options.categoria,
      );
      if (options.json === true) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      const out: string[] = [];
      for (const bucket of Object.keys(BUCKET_LABELS) as Bucket[]) {
        const rows = list.filter((o) => o.bucket === bucket);
        if (rows.length === 0) continue;
        out.push(`${BUCKET_LABELS[bucket]} (${rows.length}):`);
        for (const o of rows)
          out.push(
            `  vaga ${o.jobId} [${o.source}] ${o.company ?? '?'} — ${o.title}`,
            `      ${o.reasons[0] ?? ''}${o.missing.length > 0 ? ` | falta: ${o.missing.join(', ')}` : ''}`,
            ...(o.bucket === 'automatizavel' || o.bucket === 'manual'
              ? [`      link: ${o.url}`]
              : []),
          );
        out.push('');
      }
      console.log(out.length === 0 ? 'Nenhuma vaga.' : out.join('\n'));
    });

  const queue = cmd
    .command('queue')
    .description(
      'Fila de candidaturas (plano): automáticas e assistidas, priorizadas e prontas para execução',
    );

  queue
    .command('build')
    .description('Atualiza a fila a partir da classificação atual (não envia nada)')
    .action(() => {
      const { profile } = profileForRun(loadConfig().profilePath);
      const policy = loadPolicy();
      const result = withDb((db) => buildQueue(db, profile, policy));
      console.log(
        `Fila: ${result.created} nova(s), ${result.updated} atualizada(s), ${result.cancelled} cancelada(s); prontas: ${result.ready.automatico} automática(s), ${result.ready.assistido} assistida(s).`,
      );
    });

  queue
    .command('list')
    .description('Mostra a fila em ordem de prioridade')
    .option('--fluxo <fluxo>', 'automatico ou assistido')
    .option('--status <status>', QUEUE_STATUSES.join(', '))
    .option('--json', 'saída em JSON')
    .action((options: { fluxo?: string; status?: string; json?: boolean }) => {
      if (
        options.fluxo !== undefined &&
        options.fluxo !== 'automatico' &&
        options.fluxo !== 'assistido'
      )
        throw new Error('--fluxo aceita "automatico" ou "assistido".');
      if (
        options.status !== undefined &&
        !(QUEUE_STATUSES as readonly string[]).includes(options.status)
      )
        throw new Error(`--status aceita: ${QUEUE_STATUSES.join(', ')}.`);
      const items = withDb((db) =>
        listQueue(db, {
          ...(options.fluxo === undefined
            ? {}
            : { flow: options.fluxo as 'automatico' | 'assistido' }),
          ...(options.status === undefined ? {} : { status: options.status as QueueStatus }),
        }),
      );
      if (options.json === true) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      console.log(
        items.length === 0
          ? 'Fila vazia.'
          : items
              .map(
                (q) =>
                  `#${q.id} [${q.flow}/${q.status}] prioridade ${q.priority} — vaga ${q.jobId}: ${q.company ?? '?'} — ${q.title}\n` +
                  `      canal: ${q.connector ?? '?'}; currículo: variante "${q.cvVariant ?? '?'}"; pretensão: R$ ${q.salaryExpectation ?? '?'}\n` +
                  `      link: ${q.applyUrl ?? '(sem link)'}` +
                  (q.barriers.length > 0 ? `\n      atenção: ${q.barriers.join(' | ')}` : '') +
                  (q.evidence === null ? '' : `\n      evidência: ${q.evidence}`),
              )
              .join('\n'),
      );
    });

  queue
    .command('set <id>')
    .description(
      'Atualiza o andamento de um item (concluir exige evidência; cancelar exige motivo)',
    )
    .requiredOption('--status <status>', QUEUE_STATUSES.join(', '))
    .option('--evidencia <texto>', 'confirmação da plataforma ou e-mail recebido')
    .option('--motivo <texto>', 'motivo (cancelamento)')
    .option('--nota <texto>', 'observação')
    .action(
      (
        id: string,
        options: { status: string; evidencia?: string; motivo?: string; nota?: string },
      ) => {
        if (!(QUEUE_STATUSES as readonly string[]).includes(options.status))
          throw new Error(`--status aceita: ${QUEUE_STATUSES.join(', ')}.`);
        try {
          withDb((db) => {
            setQueueStatus(db, Number(id), {
              status: options.status as QueueStatus,
              ...(options.evidencia === undefined ? {} : { evidence: options.evidencia }),
              ...(options.motivo === undefined ? {} : { reason: options.motivo }),
              ...(options.nota === undefined ? {} : { notes: options.nota }),
            });
          });
        } catch (error) {
          if (error instanceof QueueError) throw new Error(error.message, { cause: error });
          throw error;
        }
        console.log(`Item #${id} atualizado.`);
      },
    );

  cmd
    .command('grant')
    .description(
      'Autorização permanente (concessão) do envio real: sem --confirm só mostra o resumo e o código',
    )
    .option('--days <n>', 'validade em dias (1 a 90)', '30')
    .option('--confirm <código>', 'código exibido no resumo')
    .option('--reason <texto>', 'motivo da autorização')
    .action((options: { days: string; confirm?: string; reason?: string }) => {
      const policy = loadPolicy();
      const days = Number(options.days);
      try {
        const preview = previewGrant(policy, days, new Date());
        if (options.confirm === undefined) {
          console.log(
            [
              'Concessão (nada foi gravado):',
              ...preview.summary.map((l) => `  ${l}`),
              '',
              `Para autorizar: autonomo grant --days ${days} --reason "<motivo>" --confirm ${preview.code}`,
              'O envio real continua exigindo política ligada (enabled, real.authorized) e EMAIL_SEND_ENABLED=true.',
            ].join('\n'),
          );
          return;
        }
        const id = withDb((db) =>
          createGrant(db, policy, {
            days,
            confirm: options.confirm ?? '',
            reason: options.reason ?? '',
          }),
        );
        console.log(`Concessão #${id} registrada, válida até ${preview.validUntil.slice(0, 10)}.`);
      } catch (error) {
        if (error instanceof GrantError) throw new Error(error.message, { cause: error });
        throw error;
      }
    });

  cmd
    .command('revoke <id>')
    .description('Revoga uma concessão (efeito imediato)')
    .requiredOption('--reason <texto>', 'motivo')
    .action((id: string, options: { reason: string }) => {
      try {
        withDb((db) => {
          revokeGrant(db, Number(id), options.reason);
        });
      } catch (error) {
        if (error instanceof GrantError) throw new Error(error.message, { cause: error });
        throw error;
      }
      console.log(`Concessão #${id} revogada.`);
    });

  cmd
    .command('status')
    .description('Mostra a política vigente, a concessão, a trava de parada e as últimas execuções')
    .action(() => {
      const policy = loadPolicy();
      const { grant, runs, grants } = withDb((db) => ({
        grant: latestGrant(db),
        runs: listRuns(db, 5),
        grants: listGrants(db).length,
      }));
      const auth = realAuthorization(policy, grant, new Date());
      console.log(
        [
          `Modo autônomo: ${policy.enabled ? 'LIGADO' : 'desligado'}; envio real: ${auth.ok ? `AUTORIZADO pela concessão #${auth.grant.id} até ${auth.grant.validUntil.slice(0, 10)}` : `NÃO autorizado (${auth.reason})`}. Concessões registradas: ${grants}.`,
          `Pretensão salarial padrão: ${policy.salaryExpectation.currency} ${policy.salaryExpectation.amount}; bolsa mínima (quando divulgada): ${policy.rules.minStipend}.`,
          `Limites: ${policy.limits.maxPerRun} por execução, ${policy.limits.maxPerDay} por dia, pausa de ${policy.limits.cooldownSeconds}s entre envios (o canal de e-mail impõe no mínimo 15 min).`,
          `Parada: ${existsSync(STOP_FILE) ? 'ATIVA (use "autonomo resume")' : 'não solicitada'}.`,
        ].join('\n'),
      );
      console.log(
        runs.length === 0
          ? 'Nenhuma execução registrada.'
          : runs
              .map((r) => `  #${r.id} ${r.started_at} ${r.mode} (${r.trigger}) — ${r.status}`)
              .join('\n'),
      );
    });

  cmd
    .command('history')
    .description(
      'Histórico de execuções e decisões (use --run para ver as decisões de uma execução)',
    )
    .option('--run <id>', 'decisões de uma execução')
    .option('--limit <n>', 'quantas execuções listar', '10')
    .option('--json', 'saída em JSON')
    .action((options: { run?: string; limit: string; json?: boolean }) => {
      const result = withDb((db) =>
        options.run === undefined
          ? { runs: listRuns(db, Math.max(1, Number(options.limit) || 10)) }
          : { decisions: runDecisions(db, Number(options.run)) },
      );
      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if ('runs' in result)
        console.log(
          result.runs.length === 0
            ? 'Nenhuma execução registrada.'
            : result.runs
                .map((r) => `#${r.id} ${r.started_at} ${r.mode} (${r.trigger}) — ${r.status}`)
                .join('\n'),
        );
      else
        console.log(
          result.decisions.length === 0 ? 'Sem decisões.' : result.decisions.map(line).join('\n'),
        );
    });

  cmd
    .command('stop')
    .description('Pede parada: nenhuma execução nova começa e a atual termina com segurança')
    .action(() => {
      mkdirSync(dirname(STOP_FILE), { recursive: true });
      writeFileSync(STOP_FILE, `${new Date().toISOString()}\n`);
      console.log('Parada solicitada. Use "autonomo resume" para liberar.');
    });

  cmd
    .command('resume')
    .description('Remove a trava de parada')
    .action(() => {
      rmSync(STOP_FILE, { force: true });
      console.log('Trava de parada removida.');
    });

  cmd
    .command('timer')
    .description(
      'Imprime (ou grava com --write) as unidades de systemd (user) da SIMULAÇÃO; não habilita nada',
    )
    .option(
      '--write [diretório]',
      'grava os dois arquivos (padrão: ~/.config/systemd/user); não executa systemctl',
    )
    .action((options: { write?: string | boolean }) => {
      const units = systemdUnits({ node: process.execPath, root: PROJECT_ROOT });
      if (options.write === undefined) {
        console.log(
          `# autoestagio-autonomo.service\n${units.service}\n# autoestagio-autonomo.timer\n${units.timer}\n# Habilitar (sua decisão): systemctl --user daemon-reload && systemctl --user enable --now autoestagio-autonomo.timer\n# Rodar sem sessão aberta: loginctl enable-linger $USER\n# Parar: systemctl --user disable --now autoestagio-autonomo.timer   ou   autonomo stop`,
        );
        return;
      }
      const dir = typeof options.write === 'string' ? options.write : unitDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'autoestagio-autonomo.service'), units.service);
      writeFileSync(join(dir, 'autoestagio-autonomo.timer'), units.timer);
      console.log(`Unidades gravadas em ${dir}. Nada foi habilitado nem iniciado.`);
    });

  registerExecCommand(cmd, { withDb, withDbAsync });
}
