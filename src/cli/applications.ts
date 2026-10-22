import {
  STATUS_LABELS,
  type Application,
  type ApplicationEvent,
  type ApplicationSummary,
  type Status,
} from '../applications/index.js';

/**
 * Saída de consulta. Mostra só o necessário para auditar: nunca destinatários, textos de
 * mensagens, evidências de confirmação (apenas "registrada") nem caminhos de arquivos.
 */
const short = (sha: string): string => sha.slice(0, 12);

export function formatApplicationList(items: readonly ApplicationSummary[]): string {
  if (items.length === 0) return 'Nenhuma candidatura registrada.';
  return items
    .map(
      (a) =>
        `#${a.id} [${STATUS_LABELS[a.status]}] ${a.company ?? '?'} — ${a.title}\n` +
        `    modo: ${a.mode} | canal: ${a.channel ?? '-'} | currículo: ${a.cvLabel} (${short(a.cvSha256)}) | atualizada: ${a.updatedAt}`,
    )
    .join('\n');
}

export function formatApplication(a: Application): string {
  return [
    `Candidatura #${a.id} (vaga ${a.jobId})`,
    `  estado: ${STATUS_LABELS[a.status]}`,
    `  modo: ${a.mode} | canal: ${a.channel ?? '-'}`,
    `  currículo: ${a.cvLabel} | SHA-256: ${short(a.cvSha256)}…`,
    `  elegibilidade: ${a.eligibilityVerdict}${a.eligibilityOverrideReason === null ? '' : ` (liberada por pessoa: ${a.eligibilityOverrideReason})`}`,
    `  enviada em: ${a.appliedAt ?? '-'} | confirmação: ${a.hasConfirmation ? 'registrada' : 'não'}`,
    `  criada: ${a.createdAt} | atualizada: ${a.updatedAt}`,
  ].join('\n');
}

export function formatHistory(events: readonly ApplicationEvent[]): string {
  if (events.length === 0) return 'Sem eventos.';
  return events
    .map(
      (e) =>
        `${e.createdAt}  ${e.fromStatus ?? '(início)'} → ${e.toStatus}  [${e.actor}, modo ${e.mode}, canal ${e.channel ?? '-'}]\n    ${e.reason}`,
    )
    .join('\n');
}

export function formatCounts(counts: Record<Status, number>): string {
  return Object.entries(counts)
    .map(([status, n]) => `  ${STATUS_LABELS[status as Status].padEnd(32)}${n}`)
    .join('\n');
}
