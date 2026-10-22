import type { AnalysisReport } from '../eligibility/index.js';

const LABELS = { apto: 'APTO', inapto: 'INAPTO', revisao_humana: 'REVISÃO HUMANA' } as const;

export function formatAnalysis(report: AnalysisReport, verbose: boolean): string {
  const lines: string[] = [];
  for (const { title, company, url, result } of report.jobs) {
    lines.push(`[${LABELS[result.verdict]}] ${company ?? '?'} — ${title}`, `    ${url}`);
    for (const reason of result.reasons) lines.push(`    • ${reason}`);
    if (verbose) {
      for (const c of result.criteria) {
        lines.push(`      - ${c.id} (${c.kind}): ${c.outcome} — ${c.detail}`);
      }
    }
    if (result.differentials.total > 0) {
      lines.push(`    diferenciais: ${result.differentials.matched}/${result.differentials.total}`);
    }
  }
  const { apto, inapto, revisao_humana: revisao } = report.counts;
  lines.push(
    '',
    `Total: ${report.total} | aptas: ${apto} | inaptas: ${inapto} | revisão humana: ${revisao}`,
    report.saved ? 'Resultados gravados em job_eligibility.' : 'Nada foi gravado (--no-save).',
  );
  return lines.join('\n');
}
