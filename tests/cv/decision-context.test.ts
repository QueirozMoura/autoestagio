import { beforeAll, describe, expect, it } from 'vitest';
import {
  DECISION_LIMITS,
  decisionHash,
  publicationUnits,
  verifyDecisionContext,
  verifyUsedDecisions,
  type AtomicDecision,
  type DecisionManifest,
} from '../../src/cv/decision-context.js';
import { canonicalJson, modelHash } from '../../src/cv/schema.js';
import { resolveResume } from '../../src/cv/resolve.js';
import { renderAndValidateResume } from '../../src/cv/strict.js';
import { loadFonts } from '../../src/cv/render/fonts.js';
import { approvedModel, reapprove, must, BASIS } from '../helpers/cv-approved.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';

let fixture: Loaded;
beforeAll(async () => {
  fixture = await loadFictional();
});
const date = '2026-10-23';
function prepared() {
  let model = approvedModel(fixture);
  const dev = must(model.summary.variants.find((v) => v.id === 'resumo-dev'));
  const generic = must(model.summary.variants.find((v) => v.id === 'resumo-geral'));
  dev.text = generic.text = 'Plataforma utilizada por aproximadamente 40 pessoas.';
  dev.basis = [
    { kind: 'declaracao_proprietario', ref: 'decl.json#decl-people', note: 'origem explícita' },
  ];
  generic.basis = [...BASIS];
  const skill = must(model.skills[1]);
  skill.curated = {
    text: 'Testes: Tecnologia Exemplo',
    items: ['Tecnologia Exemplo'],
    approvedAt: date,
    basis: [
      {
        kind: 'declaracao_proprietario',
        ref: 'decl.json#decl-knowledge',
        note: 'conhecimento declarado',
      },
    ],
  };
  model = reapprove(model);
  const peopleScope = {
    kind: 'people' as const,
    subject: 'Plataforma fictícia: 40 pessoas',
    limits: [...DECISION_LIMITS.people],
  };
  const knowledgeScope = {
    kind: 'knowledge' as const,
    subject: 'Tecnologia Exemplo',
    limits: [...DECISION_LIMITS.knowledge],
  };
  const sources = {
    historical: {
      status: 'confirmada',
      resolution: {
        by: 'proprietario',
        at: '2026-10-22',
        note: '40 pessoas atuais e antigas, aproximadamente.',
        scope: peopleScope,
      },
    },
    message: {
      by: 'proprietario',
      at: date,
      text: 'Conhecimento de Tecnologia Exemplo e autorização editorial.',
      scope: knowledgeScope,
    },
  };
  const decisions: AtomicDecision[] = [
    {
      id: 'decision-people',
      declarationId: 'decl-people',
      assertion: dev.text,
      scope: peopleScope,
      assertionSha256: '',
      mode: 'historical-recognition',
      recordedAt: '2026-10-23T03:00:00Z',
      recordedBy: 'codex',
      sourceId: 'historical',
      sourceKind: 'claim-resolution',
      sourcePointer: '',
      sourceSha256: decisionHash(sources.historical),
      sourceText: sources.historical.resolution.note,
      sourceDate: '2026-10-22',
      historicalOwner: 'proprietario',
    },
    {
      id: 'decision-knowledge',
      declarationId: 'decl-knowledge',
      assertion: sources.message.text,
      scope: knowledgeScope,
      assertionSha256: '',
      mode: 'owner-confirmation',
      recordedAt: '2026-10-23T03:00:00Z',
      recordedBy: 'codex',
      sourceId: 'message',
      sourceKind: 'owner-message',
      sourcePointer: '',
      sourceSha256: decisionHash(sources.message),
      sourceText: sources.message.text,
      sourceDate: date,
      historicalOwner: 'proprietario',
    },
  ];
  for (const d of decisions)
    d.assertionSha256 = decisionHash({
      declarationId: d.declarationId,
      assertion: d.assertion,
      scope: d.scope,
    });
  const declarations = {
    schemaVersion: 1 as const,
    declaracoes: [
      { id: 'decl-people', aprovada: false },
      { id: 'decl-knowledge', aprovada: false },
    ],
  };
  const resumes = [
    resolveResume(model, { extraction: fixture.extraction }),
    resolveResume(model, { extraction: fixture.extraction, area: 'desenvolvimento' }),
  ];
  const manifest: DecisionManifest = {
    schemaVersion: 1,
    modelHash: modelHash(model),
    modelSnapshotSha256: decisionHash(model),
    declarationsSha256: decisionHash(declarations),
    decisions,
    variants: resumes.map((r) => ({
      area: r.area,
      contentSha256: r.manifest.contentSha256,
      units: publicationUnits(model, r).map((u) => ({
        id: u.id,
        textSha256: decisionHash(u.text),
        inherits: u.inherits,
        decisions: u.declarations
          .map((id) => (id === 'decl-people' ? 'decision-people' : 'decision-knowledge'))
          .concat(u.id === `skill:${skill.id}:0` ? ['decision-knowledge'] : []),
      })),
    })),
  };
  return { model, declarations, resumes, bundle: { manifest, sources } };
}
const anchor = (data: ReturnType<typeof prepared>) => ({
  manifestSha256: decisionHash(data.bundle.manifest),
  sourcesSha256: decisionHash(data.bundle.sources),
  modelHash: modelHash(data.model),
});
const verify = (data: ReturnType<typeof prepared>) =>
  verifyUsedDecisions(
    verifyDecisionContext(data.bundle, anchor(data)),
    data.model,
    data.declarations,
    must(data.resumes[0]),
  );

describe('decisões atômicas e dependências de publicação', () => {
  it('rejeita JSON cíclico, profundo ou excessivo antes de copiá-lo', () => {
    const d = prepared();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = null;
    for (let i = 0; i < 70; i++) deep = { nested: deep };
    for (const sources of [cyclic, deep, { oversized: 'x'.repeat(8 * 1024 * 1024 + 1) }])
      expect(() =>
        verifyDecisionContext({ manifest: d.bundle.manifest, sources }, anchor(d)),
      ).toThrow('DECLARATIONS');
  });
  it('rejeita decisões conflitantes sobre a mesma afirmação mesmo com IDs diferentes', () => {
    const d = prepared();
    d.bundle.manifest.decisions.push({
      ...must(d.bundle.manifest.decisions[0]),
      id: 'outro-id',
      assertion: 'Outra afirmação',
    });
    expect(() => verify(d)).toThrow('DECLARATIONS');
  });
  it('reconhece uma fonte histórica e uma confirmação individual, preservando limites e booleanos', () => {
    const d = prepared();
    const before = canonicalJson(d);
    const result = verify(d);
    expect(result.decisions).toEqual(['decision-knowledge', 'decision-people']);
    expect(canonicalJson(d)).toBe(before);
    expect(d.bundle.manifest.decisions[0]?.mode).toBe('historical-recognition');
    expect(d.declarations.declaracoes.every((x) => !x.aprovada)).toBe(true);
  });
  it.each(['manifesto', 'fonte', 'escopo', 'texto', 'link', 'nome'])(
    'rejeita adulteração de %s com a âncora original',
    (attack) => {
      const d = prepared();
      const trusted = anchor(d);
      if (attack === 'fonte') d.bundle.sources.historical.resolution.note += ' adulterado';
      else if (attack === 'escopo')
        must(d.bundle.manifest.decisions[0]).scope.limits = ['advanced'];
      else if (attack === 'texto') must(d.bundle.manifest.decisions[0]).assertion += ' alterado';
      else if (attack === 'link')
        must(d.bundle.manifest.variants[0])
          .units.find((u) => u.id.startsWith('link:'))
          ?.decisions.push('decision-knowledge');
      else if (attack === 'nome')
        must(d.bundle.manifest.variants[0])
          .units.find((u) => u.id.includes('.title'))
          ?.decisions.push('decision-people');
      else d.bundle.manifest.decisions.pop();
      expect(() => verifyDecisionContext(d.bundle, trusted)).toThrow('DECLARATIONS');
    },
  );
  it('hash recalculado no bundle não substitui a âncora autorizada', () => {
    const d = prepared();
    const trusted = anchor(d);
    must(d.bundle.manifest.decisions[0]).scope.subject = 'outro fato';
    expect(decisionHash(d.bundle.manifest)).not.toBe(trusted.manifestSha256);
    expect(() => verifyDecisionContext(d.bundle, trusted)).toThrow();
  });
  it('rejeita escopo incompatível com a fonte mesmo com novo compromisso sintético', () => {
    const d = prepared();
    const decision = must(d.bundle.manifest.decisions[1]);
    decision.scope.subject = 'Outra tecnologia';
    decision.assertionSha256 = decisionHash({
      declarationId: decision.declarationId,
      assertion: decision.assertion,
      scope: decision.scope,
    });
    expect(() => verify(d)).toThrow();
  });
  it('rejeita ampliação dos limites declaratórios', () => {
    const d = prepared();
    const decision = must(d.bundle.manifest.decisions[1]);
    decision.scope.limits.push('professional-experience');
    decision.assertionSha256 = decisionHash({
      declarationId: decision.declarationId,
      assertion: decision.assertion,
      scope: decision.scope,
    });
    expect(() => verify(d)).toThrow();
  });
  it('a política de limites é imutável', () => {
    expect(Object.isFrozen(DECISION_LIMITS)).toBe(true);
    expect(Object.isFrozen(DECISION_LIMITS.knowledge)).toBe(true);
    expect(Reflect.set(DECISION_LIMITS.knowledge, 0, 'professional-experience')).toBe(false);
  });
  it('cada habilidade exige sua própria decisão, sem cobertura por outro item', () => {
    const d = prepared();
    for (const v of d.bundle.manifest.variants)
      for (const u of v.units) if (u.id.startsWith('skill:')) u.decisions = [];
    expect(() => verify(d)).toThrow('DECLARATIONS');
  });
  it.each(['ausente', 'duplicada', 'conflitante', 'ponteiro', 'fonte não confirmada', 'data'])(
    'rejeita decisão ou origem %s',
    (attack) => {
      const d = prepared();
      if (attack === 'ausente') d.bundle.manifest.decisions.pop();
      if (attack === 'duplicada')
        d.bundle.manifest.decisions.push(structuredClone(must(d.bundle.manifest.decisions[0])));
      if (attack === 'conflitante')
        d.bundle.manifest.decisions.push({
          ...must(d.bundle.manifest.decisions[0]),
          sourceText: 'conflito',
        });
      if (attack === 'ponteiro')
        must(d.bundle.manifest.decisions[0]).sourcePointer = '/inexistente';
      if (attack === 'fonte não confirmada') {
        d.bundle.sources.historical.status = 'pendente';
        must(d.bundle.manifest.decisions[0]).sourceSha256 = decisionHash(
          d.bundle.sources.historical,
        );
      }
      if (attack === 'data') must(d.bundle.manifest.decisions[0]).sourceDate = '2026-10-21';
      expect(() => verify(d)).toThrow();
    },
  );
  it.each(['modelo', 'claim', 'declaração', 'link', 'nome'])(
    'contexto fica obsoleto após mudança de %s',
    (attack) => {
      const d = prepared();
      const ctx = verifyDecisionContext(d.bundle, anchor(d));
      if (attack === 'modelo') must(d.model.summary.variants[0]).text += ' alterado';
      if (attack === 'claim')
        d.model.claims.push({
          id: 'claim-pendente',
          blockId: 'bloco-historico',
          kind: 'certificacao',
          quote: 'Retido',
          question: 'Confirma?',
          status: 'pendente',
        });
      if (attack === 'declaração') must(d.declarations.declaracoes[0]).aprovada = true;
      if (attack === 'link') must(d.model.identity.links[0]).url = 'https://outro.example/';
      if (attack === 'nome') must(d.model.experience[0]).title = 'Nome adulterado';
      expect(() => verifyUsedDecisions(ctx, d.model, d.declarations, must(d.resumes[0]))).toThrow();
    },
  );
  it.each([
    'unidade ausente',
    'unidade repetida',
    'dependência ausente',
    'herança ausente',
    'ciclo',
    'herança divergente',
  ])('bloqueia %s', (attack) => {
    const d = prepared();
    const v = must(d.bundle.manifest.variants[0]);
    const generic = must(v.units.find((u) => u.id === 'variant:resumo-geral'));
    if (attack === 'unidade ausente') v.units.pop();
    if (attack === 'unidade repetida') v.units.push(structuredClone(must(v.units[0])));
    if (attack === 'dependência ausente')
      for (const v of d.bundle.manifest.variants)
        for (const u of v.units)
          u.decisions = u.decisions.filter((id) => id !== 'decision-knowledge');
    if (attack === 'herança ausente') generic.inherits = [];
    if (attack === 'ciclo') generic.inherits = [generic.id];
    if (attack === 'herança divergente')
      generic.inherits = [must(v.units.find((u) => u.id.startsWith('field:'))).id];
    expect(() => verify(d)).toThrow();
  });
  it('claims históricos não publicados não exigem uma nova confirmação', () => {
    const d = prepared();
    d.model.claims.push({
      id: 'claim-retido',
      blockId: 'cert-antigo',
      kind: 'certificacao',
      quote: 'Texto histórico não publicado',
      question: 'Ainda pendente?',
      status: 'pendente',
    });
    d.bundle.manifest.modelSnapshotSha256 = decisionHash(d.model);
    expect(verify(d).decisions).toEqual(['decision-knowledge', 'decision-people']);
  });
  it('contextos falsos ou clonados não passam pela fronteira de confiança', () => {
    const d = prepared();
    const ctx = verifyDecisionContext(d.bundle, anchor(d));
    expect(() =>
      verifyUsedDecisions({ ...ctx }, d.model, d.declarations, must(d.resumes[0])),
    ).toThrow();
  });
  it('mutações externas após a criação do contexto não alteram o snapshot privado', () => {
    const d = prepared();
    const ctx = verifyDecisionContext(d.bundle, anchor(d));
    d.bundle.manifest.decisions = [];
    d.bundle.sources.message.text = 'mutado';
    expect(
      verifyUsedDecisions(ctx, d.model, d.declarations, must(d.resumes[0])).decisions,
    ).toHaveLength(2);
  });
  it('sem contexto, booleanos verdadeiros e aprovação global não bastam', () => {
    const d = prepared();
    for (const entry of d.declarations.declaracoes) entry.aprovada = true;
    expect(() =>
      verifyUsedDecisions(undefined, d.model, d.declarations, must(d.resumes[0])),
    ).toThrow();
  });
  it('fluxo estrito usa o contexto e mantém H1–H10 e Poppler obrigatórios', async () => {
    const d = prepared();
    const fonts = loadFonts();
    const result = await renderAndValidateResume({
      model: d.model,
      masterPdf: fixture.bytes,
      declarations: d.declarations,
      decisionContext: verifyDecisionContext(d.bundle, anchor(d)),
      referenceFonts: [
        { name: 'Lato-Regular', bytes: fonts.regular },
        { name: 'Lato-Bold', bytes: fonts.bold },
      ],
      localContext: {
        projectRoot: '/projeto/ficticio',
        userName: 'ficticio',
        hostName: 'ficticio',
      },
    });
    expect(result.report.issues).toEqual([]);
    expect(result.report.complete).toBe(true);
    expect(result.report.ok).toBe(true);
    expect(result.report.bindings?.decisions.decisions).toEqual([
      'decision-knowledge',
      'decision-people',
    ]);
    expect(result.report.diagnostic?.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(result.report.diagnostic?.extractors.every((e) => e.status === 'used')).toBe(true);
  });
});
