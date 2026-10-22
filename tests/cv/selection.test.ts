import { beforeAll, describe, expect, it } from 'vitest';
import {
  MissingApprovedVariantError,
  approvedVariants,
  buildReport,
  cvMasterSchema,
  fidelityReport,
  formatReport,
  isModelFullyApproved,
  modelHash,
  modelTexts,
  requiredBlocksWithoutApproval,
  selectForResume,
  selectVariant,
  type CvMaster,
} from '../../src/cv/index.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';

const DAY = '2026-10-22';
const BASIS = [{ kind: 'decisao_proprietario', ref: 'conversa', note: 'teste' }] as const;

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});

const fresh = (): CvMaster => structuredClone(L.model);
const blocksOf = (m: CvMaster) => [
  m.identity.headline,
  m.summary,
  ...m.experience.flatMap((e) => e.bullets),
  ...m.projects.flatMap((e) => e.bullets),
];
type Approvable = CvMaster['summary']['variants'][number];
const approve = (v: Approvable | undefined): void => {
  if (v === undefined) throw new Error('sem variante');
  v.status = 'aprovado';
  v.approvedAt = DAY;
};
/** Acrescenta uma variante editada ao bloco, no estado dado. */
function addEdited(
  block: CvMaster['summary'],
  id: string,
  status: 'rascunho' | 'aprovado' | 'rejeitado',
  areas: CvMaster['summary']['variants'][number]['areas'] = [],
): void {
  const master = block.variants[0];
  if (master === undefined) throw new Error('bloco sem variante');
  block.variants.push({
    id,
    text: `texto ${id}`,
    areas,
    technologies: [],
    origin: 'editada',
    derivedFrom: master.id,
    basis: [...BASIS],
    sourceRef: master.sourceRef,
    status,
    ...(status === 'aprovado' ? { approvedAt: DAY } : {}),
  });
}

describe('variantes: só as aprovadas valem', () => {
  it('rascunho e rejeitada nunca são selecionadas, mesmo sozinhas no bloco', () => {
    const model = fresh();
    addEdited(model.summary, 'resumo-rascunho', 'rascunho');
    addEdited(model.summary, 'resumo-rejeitada', 'rejeitado');
    expect(approvedVariants(model.summary)).toEqual([]);
    expect(selectVariant(model.summary)).toBeUndefined();
    expect(selectVariant(model.summary, 'qa')).toBeUndefined();
  });

  it('entre rascunho, rejeitada e aprovada, escolhe a aprovada (e a editada vence a do PDF)', () => {
    const model = fresh();
    addEdited(model.summary, 'resumo-rascunho', 'rascunho');
    addEdited(model.summary, 'resumo-rejeitada', 'rejeitado');
    addEdited(model.summary, 'resumo-aprovada', 'aprovado');
    const master = model.summary.variants[0];
    if (master) approve(master);
    expect(selectVariant(model.summary)?.id).toBe('resumo-aprovada');
  });

  it('por área: usa a da área, senão a genérica aprovada; nunca a de outra área nem um rascunho', () => {
    const model = fresh();
    addEdited(model.summary, 'resumo-qa', 'aprovado', ['qa']);
    addEdited(model.summary, 'resumo-infra-rascunho', 'rascunho', ['infraestrutura']);
    expect(selectVariant(model.summary, 'qa')?.id).toBe('resumo-qa');
    expect(selectVariant(model.summary, 'infraestrutura')).toBeUndefined();
    expect(selectVariant(model.summary, 'banco-de-dados')).toBeUndefined();
    expect(selectVariant(model.summary)).toBeUndefined();
    const generic = model.summary.variants[0];
    if (generic) approve(generic);
    expect(selectVariant(model.summary, 'infraestrutura')?.id).toBe(generic?.id);
    expect(selectVariant(model.summary, 'qa')?.id).toBe('resumo-qa');
  });

  it('status "rejeitado" é aceito no esquema, mas não pode ter data de aprovação', () => {
    const model = fresh();
    addEdited(model.summary, 'resumo-rejeitada', 'rejeitado');
    expect(cvMasterSchema.safeParse(model).success).toBe(true);
    const rejected = model.summary.variants.find((v) => v.id === 'resumo-rejeitada');
    if (rejected) rejected.approvedAt = DAY;
    expect(cvMasterSchema.safeParse(model).success).toBe(false);
  });
});

describe('blocos obrigatórios', () => {
  it('o cabeçalho e o resumo são obrigatórios no modelo extraído', () => {
    const required = blocksOf(L.model)
      .filter((b) => b.required)
      .map((b) => b.id);
    expect(required).toEqual(['headline', 'resumo']);
  });

  it('sem variante aprovada, o currículo não é montado (nem com rascunho disponível)', () => {
    const model = fresh();
    addEdited(model.summary, 'resumo-rascunho', 'rascunho');
    expect(requiredBlocksWithoutApproval(model)).toEqual(['headline', 'resumo']);
    expect(() => selectForResume(model)).toThrow(MissingApprovedVariantError);
    expect(() => selectForResume(model)).toThrow(/headline, resumo/);
  });

  it('aprovar só um dos obrigatórios não basta; a falta é por área quando a aprovada é de outra', () => {
    const model = fresh();
    approve(model.identity.headline.variants[0]);
    expect(requiredBlocksWithoutApproval(model)).toEqual(['resumo']);

    addEdited(model.summary, 'resumo-qa', 'aprovado', ['qa']);
    expect(requiredBlocksWithoutApproval(model, 'qa')).toEqual([]);
    expect(requiredBlocksWithoutApproval(model, 'infraestrutura')).toEqual(['resumo']);
    expect(() => selectForResume(model, 'infraestrutura')).toThrow(MissingApprovedVariantError);
  });

  it('o currículo montado só contém variantes aprovadas; opcionais sem aprovada ficam de fora', () => {
    const model = fresh();
    approve(model.identity.headline.variants[0]);
    addEdited(model.summary, 'resumo-aprovada', 'aprovado');
    addEdited(model.summary, 'resumo-rascunho', 'rascunho');
    const firstBullet = model.experience[0]?.bullets[0];
    if (firstBullet === undefined) throw new Error('sem bullet');
    addEdited(firstBullet, 'bullet-rascunho', 'rascunho');

    const chosen = selectForResume(model);
    expect(chosen.get('resumo')?.id).toBe('resumo-aprovada');
    expect(chosen.has(firstBullet.id)).toBe(false);
    for (const variant of chosen.values()) {
      expect(variant.status).toBe('aprovado');
      expect(variant.approvedAt).toBeDefined();
    }
    const usedTexts = [...chosen.values()].map((v) => v.text);
    expect(usedTexts).not.toContain('texto resumo-rascunho');
    expect(usedTexts).not.toContain('texto bullet-rascunho');
  });
});

describe('aprovação parcial não é aprovação do modelo', () => {
  /** Aprova todas as variantes de todos os blocos, menos as dos ids pedidos. */
  function approveAllExcept(model: CvMaster, skip: string[] = []): void {
    for (const block of blocksOf(model))
      if (!skip.includes(block.id)) for (const v of block.variants) approve(v);
  }

  it('aprovar muitas variantes não cria `approval` nem torna o modelo integralmente aprovado', () => {
    const model = fresh();
    approveAllExcept(model, ['resumo']);
    expect(model.approval).toBeUndefined();
    expect(isModelFullyApproved(model)).toBe(false);
    expect(requiredBlocksWithoutApproval(model)).toEqual(['resumo']);

    const report = buildReport({ model, extraction: L.extraction });
    expect(report.approval.modelApproved).toBe(false);
    expect(report.approval.blocksApproved).toBeGreaterThan(0);
    expect(report.approval.blocksApproved).toBeLessThan(report.approval.blocksTotal);
    expect(formatReport(report, model)).toContain('Modelo aprovado: NÃO');
    expect(formatReport(report, model)).not.toMatch(/Modelo aprovado: sim/);
  });

  it('mesmo com todos os blocos aprovados, sem `approval` o modelo não está integralmente aprovado', () => {
    const model = fresh();
    approveAllExcept(model);
    expect(isModelFullyApproved(model)).toBe(false);
  });

  it('não se pode registrar `approval` com um bloco sem variante aprovada', () => {
    const model = fresh();
    approveAllExcept(model, ['resumo']);
    const withApproval = { ...model, approval: { approvedAt: DAY, modelHash: modelHash(model) } };
    const result = cvMasterSchema.safeParse(withApproval);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/ao menos uma variante aprovada/);
  });

  it('só é integral com `approval` do conteúdo atual; mudar o conteúdo depois invalida a aprovação', () => {
    const model = fresh();
    approveAllExcept(model);
    const approved = { ...model, approval: { approvedAt: DAY, modelHash: modelHash(model) } };
    expect(cvMasterSchema.safeParse(approved).success).toBe(true);
    expect(isModelFullyApproved(approved)).toBe(true);

    const changed = structuredClone(approved);
    const bullet = changed.experience[0]?.bullets[0]?.variants[0];
    if (bullet) bullet.text = `${bullet.text} (alterado depois)`;
    const result = cvMasterSchema.safeParse(changed);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/aprovação obsoleta/);
    expect(isModelFullyApproved(changed)).toBe(false);
  });

  it('um bloco só com variantes rascunho/rejeitada impede a aprovação integral', () => {
    const model = fresh();
    approveAllExcept(model, ['resumo']);
    addEdited(model.summary, 'resumo-rejeitada', 'rejeitado');
    const withApproval = { ...model, approval: { approvedAt: DAY, modelHash: modelHash(model) } };
    expect(cvMasterSchema.safeParse(withApproval).success).toBe(false);
  });
});

describe('fidelidade: compara exclusivamente o conteúdo original do PDF', () => {
  it('variantes editadas (mesmo com palavras e números novos), curadoria e títulos não entram na comparação', () => {
    const baseline = fidelityReport(L.model, L.extraction);
    const model = fresh();
    addEdited(model.summary, 'resumo-novo', 'aprovado', ['qa']);
    const edited = model.summary.variants.find((v) => v.id === 'resumo-novo');
    if (edited) edited.text = 'Palavras inéditas zzzquux 99999 que não existem no PDF.';
    const entry = model.experience[0];
    if (entry === undefined) throw new Error('sem entrada');
    entry.curated = {
      title: 'Título inédito zzzquux',
      technologies: ['Tecnologia inédita'],
      approvedAt: DAY,
      basis: [...BASIS],
    };
    model.sectionTitles = {
      experience: 'Seção inédita',
      projects: 'Outra seção inédita',
      approvedAt: DAY,
      basis: [...BASIS],
    };

    const r = fidelityReport(model, L.extraction);
    expect(r.verdict).toBe('fiel');
    expect(r.blocks).toEqual(baseline.blocks);
    expect(r.bySection).toEqual(baseline.bySection);
    expect(r.notInPdf).toEqual([]);
    expect(r.omittedFromModel).toEqual([]);
    expect(r.numbers).toEqual({ inPdfNotModel: [], inModelNotPdf: [] });
    expect(modelTexts(model).map((u) => u.id)).toEqual(modelTexts(L.model).map((u) => u.id));
  });

  it('alterar o texto de uma variante do PDF continua sendo detectado', () => {
    const model = fresh();
    const original = model.summary.variants[0];
    if (original === undefined) throw new Error('sem variante');
    original.text = `${original.text} Acréscimo inventado zzzquux.`;
    const r = fidelityReport(model, L.extraction);
    expect(r.verdict).toBe('divergente');
    expect(r.blocks.missing.map((m) => m.id)).toContain(original.id);
  });

  it('aprovar uma variante do PDF não altera a fidelidade', () => {
    const model = fresh();
    for (const block of blocksOf(model)) for (const v of block.variants) approve(v);
    expect(fidelityReport(model, L.extraction)).toEqual(fidelityReport(L.model, L.extraction));
  });
});
