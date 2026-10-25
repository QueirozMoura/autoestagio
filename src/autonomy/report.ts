import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import { listQueue } from './queue.js';
import type { RunReport } from './run.js';

export function saveMorningReport(
  db: Db,
  report: RunReport,
  dir: string,
): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const queue = listQueue(db);
  const items = report.preparation?.items ?? [];
  const summary = {
    found: report.discovery?.found ?? null,
    newJobs: report.discovery?.newJobs ?? 0,
    prepared: items.filter(
      (i) => i.outcome === 'pronto_para_revisao' && report.preparation?.mode === 'preparar',
    ).length,
    partiallyPrepared: items.filter(
      (i) => i.outcome === 'campos_desconhecidos' && i.filled.some((f) => f.ok),
    ).length,
    autoChannelCompatible: report.opportunities.buckets.automatizavel,
    wouldSend: report.counts.candidatar ?? 0,
    sent: report.counts.enviada ?? 0,
    autoApplyAuthorized: report.autoApply?.checks.filter((check) => check.ok).length ?? 0,
    confirmed: report.autoApply?.states.filter((state) => state.state === 'confirmada').length ?? 0,
    humanRequired: queue.filter((q) => q.status === 'pendente_humano').length,
    remainingReady: queue.filter((q) => q.status === 'pronta').length,
  };
  const data = { generatedAt: new Date().toISOString(), summary, run: report, queue };
  const markdown = [
    `# AutoEstágio — execução ${report.runId}`,
    `Modo de envio: **${report.mode}**. Preparo: **${report.preparation?.mode ?? 'não executado'}**. Resultado: ${report.status}.`,
    `Encontradas na coleta: ${summary.found ?? 'não coletado'}; novas: ${summary.newJobs}.`,
    `Preparadas para revisão: ${summary.prepared}; parcialmente preparadas: ${summary.partiallyPrepared}.`,
    `Canal compatível com envio automático: ${summary.autoChannelCompatible}; candidataria dentro dos limites: ${summary.wouldSend}; enviadas: ${summary.sent}.`,
    `Intervenção humana na fila: ${summary.humanRequired}; ainda prontas: ${summary.remainingReady}.`,
    '',
    '## Preparação',
    '',
    ...items.map(
      (i) =>
        `- Fila #${i.queueId}: ${i.outcome}. Campos conferidos: ${i.filled.filter((f) => f.ok).length}/${i.filled.length}. Pendências: ${i.needsHuman.map((h) => h.label).join('; ') || 'nenhuma'}. ${i.notes.join('; ')}${i.screenshot ? ` Captura: ${i.screenshot}` : ''}`,
    ),
    '',
    '## Fila',
    '',
    '| Fila | Empresa / vaga | Estado |',
    '| --- | --- | --- |',
    ...queue.map(
      (q) =>
        `| ${q.id} | ${`${q.company ?? '?'} — ${q.title}`.replace(/\|/g, '/')} | ${q.status} |`,
    ),
    '',
    '## Limites e bloqueios',
    '',
    ...(report.autoApply
      ? [
          `AUTO_APPLY: ${summary.autoApplyAuthorized} vaga(s) com manifesto compatível. Aceite da API de e-mail não comprova recebimento pelo recrutador.`,
          ...report.autoApply.checks
            .filter((check) => !check.ok)
            .map((check) => `- Vaga ${check.jobId}: ${check.reason}`),
          '',
          'Estados das candidaturas:',
          ...report.autoApply.states.map((state) => `- Vaga ${state.jobId}: ${state.state}`),
        ]
      : []),
    'Preparação nunca aciona envio. Login, CAPTCHA, avaliação, termos, autodeclarações e perguntas sem dados comprovados exigem revisão humana. Formulários preenchidos em sessão headless são evidenciados por captura; não são rascunhos garantidamente salvos pelo portal.',
    ...report.notes,
    ...report.errors.map((e) => `Erro: ${e}`),
  ].join('\n');
  const paths = {
    json: join(dir, `run-${report.runId}.json`),
    markdown: join(dir, `run-${report.runId}.md`),
  };
  for (const [path, content] of [
    [paths.json, JSON.stringify(data, null, 2)],
    [paths.markdown, markdown],
    [join(dir, 'latest.json'), JSON.stringify(data, null, 2)],
    [join(dir, 'latest.md'), markdown],
  ]) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content as string, { mode: 0o600 });
    renameSync(temporary, path as string);
  }
  return paths;
}
