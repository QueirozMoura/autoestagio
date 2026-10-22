import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildReport,
  cvMasterSchema,
  detectClaims,
  fidelityReport,
  formatReport,
  modelHash,
  modelTexts,
  type CvMaster,
} from '../../src/cv/index.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';

const BASIS = [
  { kind: 'decisao_proprietario', ref: 'conversa', note: 'texto aprovado pelo proprietário' },
] as const;

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});

/** Cópia do modelo com uma variante editada (e aprovada) no resumo. */
function withEditedSummary(): CvMaster {
  const model = structuredClone(L.model);
  const original = model.summary.variants[0];
  if (original === undefined) throw new Error('sem variante');
  model.summary.variants.push({
    id: 'resumo-editado',
    text: 'Texto revisado que não existe no PDF mestre.',
    areas: ['desenvolvimento'],
    technologies: [],
    origin: 'editada',
    derivedFrom: original.id,
    basis: [...BASIS],
    sourceRef: original.sourceRef,
    status: 'aprovado',
    approvedAt: '2026-10-22',
  });
  return model;
}

describe('variantes editadas (textos revisados pelo proprietário)', () => {
  it('são aceitas com derivedFrom e base, e não contam na fidelidade com o PDF', () => {
    const model = withEditedSummary();
    expect(cvMasterSchema.safeParse(model).success).toBe(true);
    expect(modelTexts(model).some((u) => u.id === 'resumo-editado')).toBe(false);
    expect(fidelityReport(model, L.extraction).verdict).toBe('fiel');
  });

  it('exigem derivedFrom, base e uma variante do mestre existente', () => {
    const noDerived = withEditedSummary();
    delete noDerived.summary.variants[1]?.derivedFrom;
    expect(JSON.stringify(cvMasterSchema.safeParse(noDerived).error?.issues)).toMatch(
      /derivedFrom existe se/,
    );

    const noBasis = withEditedSummary();
    const edited = noBasis.summary.variants[1];
    if (edited) edited.basis = [];
    expect(JSON.stringify(cvMasterSchema.safeParse(noBasis).error?.issues)).toMatch(
      /ao menos uma base/,
    );

    const dangling = withEditedSummary();
    const d = dangling.summary.variants[1];
    if (d) d.derivedFrom = 'resumo-inexistente';
    expect(JSON.stringify(cvMasterSchema.safeParse(dangling).error?.issues)).toMatch(
      /variante do mestre inexistente/,
    );

    const masterWithDerived = structuredClone(L.model);
    const m = masterWithDerived.summary.variants[0];
    if (m) m.derivedFrom = 'qualquer-id';
    expect(cvMasterSchema.safeParse(masterWithDerived).success).toBe(false);
  });

  it('mudam o hash do conteúdo, mas não alteram o texto do mestre', () => {
    const model = withEditedSummary();
    expect(modelHash(model)).not.toBe(modelHash(L.model));
    expect(model.summary.variants[0]?.text).toBe(L.model.summary.variants[0]?.text);
  });

  it('o modelo só é aprovável com ao menos uma variante aprovada em cada bloco', () => {
    const model = withEditedSummary();
    const approved = structuredClone(model);
    for (const b of [
      approved.identity.headline,
      ...approved.experience.flatMap((e) => e.bullets),
      ...approved.projects.flatMap((e) => e.bullets),
    ])
      for (const v of b.variants) {
        v.status = 'aprovado';
        v.approvedAt = '2026-10-22';
      }
    // O resumo mestre continua em rascunho, mas a editada está aprovada: basta.
    const ok = {
      ...approved,
      approval: { approvedAt: '2026-10-22', modelHash: modelHash(approved) },
    };
    expect(cvMasterSchema.safeParse(ok).success).toBe(true);

    // Sem nenhuma variante aprovada no resumo: recusado.
    const none = structuredClone(ok);
    const e = none.summary.variants[1];
    if (e) {
      e.status = 'rascunho';
      delete e.approvedAt;
    }
    expect(JSON.stringify(cvMasterSchema.safeParse(none).error?.issues)).toMatch(
      /ao menos uma variante aprovada/,
    );
  });
});

describe('afirmações resolvidas', () => {
  const resolved = (): CvMaster => {
    const model = structuredClone(L.enriched);
    const claim = model.claims[0];
    if (claim === undefined) throw new Error('sem afirmações');
    claim.status = 'confirmada';
    claim.resolution = {
      at: '2026-10-22',
      by: 'proprietario',
      note: 'confirmado',
      basis: [...BASIS],
    };
    return model;
  };

  it('status resolvido exige resolution (e vice-versa)', () => {
    expect(cvMasterSchema.safeParse(resolved()).success).toBe(true);
    const noResolution = resolved();
    delete noResolution.claims[0]?.resolution;
    expect(cvMasterSchema.safeParse(noResolution).success).toBe(false);
    const pendingWithResolution = structuredClone(L.enriched);
    const c = pendingWithResolution.claims[0];
    if (c) c.resolution = { at: '2026-10-22', by: 'proprietario', note: 'x', basis: [] };
    expect(cvMasterSchema.safeParse(pendingWithResolution).success).toBe(false);
  });

  it('o relatório respeita o que já foi resolvido, em vez de redetectar tudo como pendente', () => {
    const model = resolved();
    const first = model.claims[0];
    const report = buildReport({ model, extraction: L.extraction });
    const found = report.claims.find((c) => c.id === first?.id);
    expect(found?.status).toBe('confirmada');
    expect(found?.resolution?.note).toBe('confirmado');
    expect(report.claims.filter((c) => c.status === 'pendente').length).toBe(
      detectClaims(model).claims.length - 1,
    );
    const text = formatReport(report, model);
    expect(text).toContain('1 confirmadas');
  });

  it('inconsistência resolvida deixa de aparecer na lista de inconsistências', () => {
    const model = structuredClone(L.enriched);
    const open = buildReport({ model, extraction: L.extraction }).inconsistencies.length;
    for (const c of model.claims)
      if (c.kind === 'inconsistencia') {
        c.status = 'rejeitada';
        c.resolution = {
          at: '2026-10-22',
          by: 'proprietario',
          note: 'texto substituído',
          basis: [],
        };
      }
    const closed = buildReport({ model, extraction: L.extraction }).inconsistencies.length;
    expect(closed).toBe(0);
    expect(open).toBeGreaterThanOrEqual(closed);
  });
});

describe('curadoria de título, skills, certificação e seções', () => {
  it('aceita curated com base e recusa curated sem base ou vazio', () => {
    const model = structuredClone(L.model);
    const entry = model.experience[0];
    const skill = model.skills[0];
    if (entry === undefined || skill === undefined) throw new Error('faltam dados');
    entry.curated = { title: 'Título revisado', approvedAt: '2026-10-22', basis: [...BASIS] };
    skill.curated = {
      items: ['A', 'B'],
      text: 'Categoria: A, B',
      approvedAt: '2026-10-22',
      basis: [...BASIS],
    };
    model.sectionTitles = {
      experience: 'Experiência em projetos',
      projects: 'Outros projetos',
      approvedAt: '2026-10-22',
      basis: [...BASIS],
    };
    expect(cvMasterSchema.safeParse(model).success).toBe(true);

    const noBasis = structuredClone(model);
    const e = noBasis.experience[0];
    if (e?.curated) e.curated.basis = [];
    expect(cvMasterSchema.safeParse(noBasis).success).toBe(false);

    const empty = structuredClone(model);
    const e2 = empty.experience[0];
    if (e2) e2.curated = { approvedAt: '2026-10-22', basis: [...BASIS] };
    expect(cvMasterSchema.safeParse(empty).success).toBe(false);
  });

  it('a curadoria não altera a fidelidade com o PDF', () => {
    const model = structuredClone(L.model);
    const entry = model.experience[0];
    if (entry === undefined) throw new Error('sem entrada');
    entry.curated = { title: 'Outro título', approvedAt: '2026-10-22', basis: [...BASIS] };
    expect(fidelityReport(model, L.extraction).verdict).toBe('fiel');
  });
});
