import type { RunCounters, ScanReport } from '../discovery/index.js';

const COLUMNS: readonly (readonly [header: string, value: (c: RunCounters) => number])[] = [
  ['lidas', (c) => c.found],
  ['novas', (c) => c.new],
  ['repetidas', (c) => c.duplicates],
  ['atualizadas', (c) => c.updated],
  ['possíveis', (c) => c.possibleDuplicates],
  ['inválidas', (c) => c.invalid],
  ['falhas', (c) => c.failed],
];

const NAME_WIDTH = 32;

function row(name: string, cells: readonly string[]): string {
  const padded = cells.map((cell, index) => cell.padStart(COLUMNS[index]?.[0].length ?? 0));
  return `  ${name.padEnd(NAME_WIDTH)}${padded.join('  ')}`;
}

export function formatScanReport(report: ScanReport, index: number, total: number): string {
  const lines = [
    `Execução ${index + 1}/${total}${report.simulated ? ' (simulada)' : ''}`,
    row(
      'fonte',
      COLUMNS.map(([header]) => header),
    ),
  ];
  const counts = (counters: RunCounters): string[] =>
    COLUMNS.map(([, value]) => String(value(counters)));

  for (const source of report.sources) {
    lines.push(row(source.source, counts(source)));
    if (source.error !== null) lines.push(`    ! ${source.error}`);
    for (const failure of source.failures) lines.push(`    ! ${failure}`);
  }
  lines.push(row('TOTAL', counts(report.totals)));
  return lines.join('\n');
}
