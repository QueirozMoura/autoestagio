import type { EditorialState, StrictInputsErrorCode, VariantInfo } from '../cv/strict-inputs.js';

const EDITORIAL: Record<EditorialState, string> = {
  aprovada: 'aprovada',
  rascunho: 'rascunho',
  rejeitada: 'rejeitada',
  ausente: 'ausente',
};

const REASONS: Record<StrictInputsErrorCode, string> = {
  MODEL_MISSING: 'modelo ausente',
  MODEL_INVALID: 'modelo inválido',
  MASTER_MISSING: 'PDF mestre ausente',
  MASTER_MISMATCH: 'PDF mestre divergente',
  DECLARATIONS_MISSING: 'declarações ausentes',
  DECLARATIONS_INVALID: 'declarações inválidas',
  ANCHOR_REFERENCE_MISSING: 'referência da âncora não informada',
  ANCHOR_MISSING: 'âncora ausente',
  ANCHOR_MISMATCH: 'âncora diverge da referência',
  ANCHOR_INVALID: 'âncora inválida',
  APPROVAL_MISSING: 'aprovação global ausente',
  APPROVAL_INVALID: 'aprovação global inválida',
  APPROVAL_STALE: 'aprovação obsoleta',
  DECISIONS_MISSING: 'decisões ausentes',
  DECISIONS_INVALID: 'decisões inválidas',
  VARIANT_UNKNOWN: 'variante inexistente',
  VARIANT_NOT_ELIGIBLE: 'variante não aprovada',
  VARIANT_NOT_IN_DECISIONS: 'variante fora do manifesto de decisões',
  FONTS_INVALID: 'fontes de referência inválidas',
  LOCAL_CONTEXT_INVALID: 'contexto local inválido',
  POPPLER_MISSING: 'Poppler ausente',
  UNSAFE_FILE: 'arquivo privado inseguro',
};

export function formatVariants(variants: readonly VariantInfo[]): string {
  const rows = variants.map((v) => [
    v.id,
    v.name,
    EDITORIAL[v.editorial],
    v.selectionEligible ? 'elegível' : 'não elegível',
    v.preconditions.verified ? 'verificadas' : `indisponíveis (${REASONS[v.preconditions.code]})`,
  ]);
  const header = ['ID', 'Nome', 'Editorial', 'Seleção', 'Pré-condições locais'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    'Variantes de currículo',
    '',
    line(header),
    ...rows.map(line),
    '',
    'A validação estrita NÃO foi executada por este comando: só a geração a atesta.',
  ].join('\n');
}

/** Saída JSON: apenas metadados e códigos; nenhum conteúdo, caminho ou hash. */
export function variantsJson(variants: readonly VariantInfo[]): unknown {
  return variants.map((v) => ({
    id: v.id,
    name: v.name,
    editorial: v.editorial,
    selectionEligible: v.selectionEligible,
    preconditions: v.preconditions.verified
      ? { verified: true }
      : { verified: false, code: v.preconditions.code },
    strictValidation: v.strictValidation,
  }));
}
