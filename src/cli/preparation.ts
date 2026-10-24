import { STATUS_LABELS } from '../applications/index.js';
import {
  READINESS_LABELS,
  type Candidate,
  type PrepareResult,
  type PreparationView,
} from '../preparation/index.js';

/**
 * Pré-visualização no terminal. Mostra a mensagem exatamente como seria enviada e o que falta,
 * mas nunca: destinatários, caminhos, hash do perfil, respostas (salvo --show-answers) nem o
 * SHA-256 completo do currículo.
 */
export function formatPreview(view: PreparationView): string {
  const { application: a } = view;
  const lines = [
    `Candidatura #${a.id} — ${view.company ?? '?'} — ${view.jobTitle}`,
    `  estado: ${STATUS_LABELS[a.status]} | modo: ${a.mode} | canal: ${a.channel ?? '(não definido)'}`,
    `  currículo: ${a.cvLabel} (SHA-256 ${a.cvSha256.slice(0, 12)}…, arquivo original, sem alterações)`,
    `  situação do preparo: ${READINESS_LABELS[view.readiness]}`,
    '  NADA FOI ENVIADO. Isto é só uma pré-visualização.',
    '',
  ];
  if (view.draft === null) {
    lines.push('(sem rascunho: rode "applications prepare <vaga>")');
  } else {
    lines.push(
      '── Assunto ─────────────────────────────────────────────',
      view.draft.subject,
      '── Mensagem ────────────────────────────────────────────',
      view.draft.body,
      '── De onde vem cada afirmação ──────────────────────────',
      ...view.draft.facts.map((fact) => `  • ${fact.claim}  ←  ${fact.source}`),
    );
    if (view.draft.reviewedAt !== null)
      lines.push(`  revisada por você em ${view.draft.reviewedAt}`);
  }

  lines.push('', '── Pendências ──────────────────────────────────────────');
  if (view.requirements.length === 0) lines.push('  nenhuma');
  for (const requirement of view.requirements) {
    const mark = requirement.answered
      ? `[ok, por ${requirement.answeredBy ?? '?'}]`
      : requirement.blocking
        ? '[PENDENTE]'
        : '[aviso]';
    lines.push(`  ${mark} ${requirement.key}: ${requirement.label}`);
    if (requirement.answer !== undefined) lines.push(`      resposta: ${requirement.answer}`);
  }
  return lines.join('\n');
}

const OUTCOMES: Record<string, string> = {
  preparada: 'Candidatura preparada',
  regenerada: 'Rascunho regenerado',
  inalterada: 'Nada a fazer: já está preparada e atualizada',
  desatualizada: 'Rascunho desatualizado (use --regenerate)',
};

export function formatPrepareResult(result: PrepareResult): string {
  if (result.outcome === 'recusada') return `Recusada (${result.reason}): ${result.detail}`;
  return [
    `${OUTCOMES[result.outcome] ?? result.outcome}: candidatura #${result.applicationId}.`,
    `  situação: ${READINESS_LABELS[result.readiness]}`,
    ...(result.warnings > 0
      ? [`  aviso: já há candidatura a outra vaga da mesma empresa (${result.warnings})`]
      : []),
    `  revise com: applications preview ${result.applicationId}`,
    '  Modo dry-run: nada foi enviado.',
  ].join('\n');
}

export function formatCandidates(items: readonly Candidate[], explain = false): string {
  if (items.length === 0)
    return 'Nenhuma vaga elegível sem candidatura. Rode "analyze" para atualizar.';
  return items
    .map((c) => {
      const head = `${String(c.position).padStart(2)}. vaga ${c.jobId} [${c.verdict === 'apto' ? 'APTO' : 'REVISÃO HUMANA: exige --override-review'}] ${c.company ?? '?'} — ${c.title}`;
      return explain ? [head, ...c.explanation.map((line) => `      ${line}`)].join('\n') : head;
    })
    .join('\n');
}
