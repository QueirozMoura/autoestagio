import type { Area } from '../eligibility/areas.js';
import { modelHash, type CvMaster, type VariantBlock } from './schema.js';

/**
 * Seleção de variantes para um currículo final. A regra é uma só: SÓ vale variante `aprovado` com
 * `approvedAt`. Rascunho e rejeitada nunca são escolhidas, nem como "quebra-galho" quando falta uma
 * aprovada, e a aprovação parcial de variantes nunca equivale à aprovação do modelo inteiro.
 */
export type Variant = VariantBlock['variants'][number];

export class MissingApprovedVariantError extends Error {
  constructor(readonly blockIds: string[]) {
    super(`Blocos obrigatórios sem variante aprovada: ${blockIds.join(', ')}.`);
    this.name = 'MissingApprovedVariantError';
  }
}

export const isUsableVariant = (variant: Variant): boolean =>
  variant.status === 'aprovado' && variant.approvedAt !== undefined;

export const approvedVariants = (block: VariantBlock): Variant[] =>
  block.variants.filter(isUsableVariant);

/**
 * Variante aprovada para a área: a específica da área; senão a genérica (sem área). Nunca a de outra
 * área. Entre aprovadas, a `editada` (revisada) vence a do PDF.
 */
export function selectVariant(block: VariantBlock, area?: Area): Variant | undefined {
  const usable = [...approvedVariants(block)].sort(
    (a, b) => Number(b.origin === 'editada') - Number(a.origin === 'editada'),
  );
  if (area !== undefined) {
    const specific = usable.find((v) => v.areas.includes(area));
    if (specific !== undefined) return specific;
  }
  return usable.find((v) => v.areas.length === 0);
}

const allBlocks = (model: CvMaster): VariantBlock[] => [
  model.identity.headline,
  model.summary,
  ...model.experience.flatMap((e) => e.bullets),
  ...model.projects.flatMap((e) => e.bullets),
];

/** Ids dos blocos obrigatórios sem variante utilizável (para a área, se informada). */
export function requiredBlocksWithoutApproval(model: CvMaster, area?: Area): string[] {
  return allBlocks(model)
    .filter((b) => b.required && selectVariant(b, area) === undefined)
    .map((b) => b.id);
}

/**
 * Variantes escolhidas para um currículo. Falha se algum bloco obrigatório não tiver variante
 * aprovada; blocos opcionais sem aprovada são omitidos (nunca substituídos por rascunho).
 */
export function selectForResume(model: CvMaster, area?: Area): Map<string, Variant> {
  const missing = requiredBlocksWithoutApproval(model, area);
  if (missing.length > 0) throw new MissingApprovedVariantError(missing);
  const chosen = new Map<string, Variant>();
  for (const block of allBlocks(model)) {
    const variant = selectVariant(block, area);
    if (variant !== undefined) chosen.set(block.id, variant);
  }
  return chosen;
}

/**
 * Modelo integralmente aprovado: tem `approval` válido para o conteúdo atual E todo bloco tem ao menos
 * uma variante aprovada. Variantes aprovadas isoladamente não bastam.
 */
export function isModelFullyApproved(model: CvMaster): boolean {
  return (
    model.approval !== undefined &&
    model.approval.modelHash === modelHash(model) &&
    allBlocks(model).every((b) => approvedVariants(b).length > 0)
  );
}
