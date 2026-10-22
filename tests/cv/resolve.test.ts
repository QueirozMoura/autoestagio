import { beforeAll, describe, expect, it } from 'vitest';
import {
  ResumeResolutionError,
  bannedPhrases,
  effectiveCertification,
  effectiveEntryTechnologies,
  effectiveEntryTitle,
  effectiveSectionTitles,
  effectiveSkill,
  extractPdfBytes,
  modelHash,
  resolveResume,
  tryResolveResume,
  type CvMaster,
} from '../../src/cv/index.js';
import type { Entry } from '../../src/cv/schema.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { makeFictionalMasterPdf } from '../helpers/master-pdf.js';

const DAY = '2026-10-22';
const BASIS = [{ kind: 'decisao_proprietario', ref: 'conversa', note: 'teste' }] as const;
const GENERIC = 'Resumo genérico aprovado, sem área.';
const DEV = 'Resumo aprovado de Desenvolvimento.';
const QA = 'Resumo aprovado de QA.';
const SENTINEL_DRAFT = 'TEXTO-EM-RASCUNHO-NAO-PODE-SAIR';
const SENTINEL_REJECTED = 'TEXTO-REJEITADO-NAO-PODE-SAIR';

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('valor ausente no teste');
  return value;
};
type Block = CvMaster['summary'];
type VariantT = Block['variants'][number];

function approveVariant(v: VariantT): void {
  v.status = 'aprovado';
  v.approvedAt = DAY;
}
function addVariant(
  block: Block,
  id: string,
  text: string,
  status: 'rascunho' | 'aprovado' | 'rejeitado',
  areas: VariantT['areas'] = [],
): void {
  const master = must(block.variants[0]);
  block.variants.push({
    id,
    text,
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
const entryById = (m: CvMaster, id: string): Entry =>
  must([...m.experience, ...m.projects].find((e) => e.id === id));
const reapprove = (m: CvMaster): CvMaster => ({
  ...m,
  approval: { approvedAt: DAY, modelHash: modelHash(m) },
});

/** Modelo fictício aprovado: resumos genérico/Dev/QA, curadoria, links confirmados (menos o LinkedIn). */
function approvedModel(): CvMaster {
  const m = structuredClone(L.enriched);
  m.claims = []; // as afirmações entram nos testes que precisam delas
  approveVariant(must(m.identity.headline.variants[0]));
  addVariant(m.summary, 'resumo-geral', GENERIC, 'aprovado');
  addVariant(m.summary, 'resumo-dev', DEV, 'aprovado', ['desenvolvimento']);
  addVariant(m.summary, 'resumo-qa', QA, 'aprovado', ['qa']);

  for (const block of [...m.experience, ...m.projects].flatMap((e) => e.bullets)) {
    addVariant(block, `${block.id}-draft`, `${SENTINEL_DRAFT} ${block.id}`, 'rascunho');
    addVariant(block, `${block.id}-rej`, `${SENTINEL_REJECTED} ${block.id}`, 'rejeitado');
    approveVariant(must(block.variants[0]));
  }
  // Bullets com número de usuários: a versão aprovada é a editada ("aproximadamente").
  for (const [id, text] of [
    [
      'exp-oficina-exemplo-ltda-b1',
      'Mantenho uma plataforma utilizada por aproximadamente 40 pessoas.',
    ],
    ['exp-agendamais-b1', 'Desenvolvi uma plataforma utilizada por aproximadamente 25 pessoas.'],
  ] as const) {
    const block = must(
      [...m.experience, ...m.projects].flatMap((e) => e.bullets).find((b) => b.id === id),
    );
    must(block.variants[0]).status = 'rascunho';
    delete must(block.variants[0]).approvedAt;
    addVariant(block, `${id}-editada`, text, 'aprovado');
  }

  const oficina = entryById(m, 'exp-oficina-exemplo-ltda');
  oficina.curated = {
    title: 'Oficina Exemplo — título curado',
    technologies: ['React', 'IndexedDB'],
    approvedAt: DAY,
    basis: [...BASIS],
  };
  const skill = must(m.skills[1]);
  skill.curated = {
    items: ['Vitest', 'Playwright'],
    text: `${skill.category}: Vitest, Playwright`,
    approvedAt: DAY,
    basis: [...BASIS],
  };
  const cert = must(m.certifications[0]);
  cert.curated = {
    text: 'Fundamentos de APIs REST — Instituto Exemplo',
    title: cert.title,
    issuer: cert.issuer,
    withheld: ['year', 'description'],
    approvedAt: DAY,
    basis: [...BASIS],
  };
  m.sectionTitles = {
    experience: 'Experiência em projetos',
    projects: 'Outros projetos',
    approvedAt: DAY,
    basis: [...BASIS],
  };

  const links = [
    ...m.identity.links,
    ...m.experience.flatMap((e) => e.links),
    ...m.projects.flatMap((e) => e.links),
  ];
  for (const l of links)
    if (l.id !== 'link-linkedin') {
      l.confirmedByUser = true;
      l.status = 'aprovado';
      l.approvedAt = DAY;
    }
  return reapprove(m);
}

const resolve = (m: CvMaster, area?: Parameters<typeof resolveResume>[1]['area']) =>
  resolveResume(m, { extraction: L.extraction, ...(area === undefined ? {} : { area }) });
const failure = (fn: () => unknown): ResumeResolutionError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ResumeResolutionError) return error;
    throw error;
  }
  throw new Error('deveria ter falhado');
};

describe('seleção estrita por área', () => {
  it('sem área: resumo genérico', () => {
    const r = resolve(approvedModel());
    expect(r.summary).toBe(GENERIC);
    expect(r.area).toBeNull();
    expect(r.manifest.area).toBeNull();
    expect(r.manifest.variants).toContainEqual(
      expect.objectContaining({ blockId: 'resumo', variantId: 'resumo-geral', origin: 'editada' }),
    );
  });

  it('com área: somente o resumo aprovado daquela área', () => {
    expect(resolve(approvedModel(), 'qa').summary).toBe(QA);
    expect(resolve(approvedModel(), 'desenvolvimento').summary).toBe(DEV);
    expect(resolve(approvedModel(), 'qa').manifest.area).toBe('qa');
  });

  it('área sem resumo aprovado (Suporte, Dados, Infraestrutura): falha controlada, sem fallback genérico', () => {
    for (const area of ['suporte', 'dados', 'infraestrutura'] as const) {
      const model = approvedModel();
      const error = failure(() => resolve(model, area));
      expect(error.code).toBe('MISSING_APPROVED_VARIANT');
      expect(error.details).toEqual(['resumo']);
      expect(error.message).toMatch(/não há fallback/);
      const result = tryResolveResume(model, { area, extraction: L.extraction });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('MISSING_APPROVED_VARIANT');
    }
  });

  it('variante de área em rascunho ou rejeitada não vira resumo, e o genérico não a substitui', () => {
    const model = approvedModel();
    addVariant(model.summary, 'resumo-dados-rascunho', 'Rascunho de Dados.', 'rascunho', ['dados']);
    addVariant(model.summary, 'resumo-suporte-rej', 'Rejeitado de Suporte.', 'rejeitado', [
      'suporte',
    ]);
    const approved = reapprove(model);
    expect(failure(() => resolve(approved, 'dados')).code).toBe('MISSING_APPROVED_VARIANT');
    expect(failure(() => resolve(approved, 'suporte')).code).toBe('MISSING_APPROVED_VARIANT');
    expect(resolve(approved).summary).toBe(GENERIC);
  });

  it('entrada sem bullet aprovado para a área é omitida e registrada no manifesto', () => {
    const model = approvedModel();
    const notas = entryById(model, 'proj-notasfacil');
    for (const block of notas.bullets) {
      for (const v of block.variants) {
        v.status = v.id.endsWith('-rej') ? 'rejeitado' : 'rascunho';
        delete v.approvedAt;
      }
      addVariant(block, `${block.id}-so-qa`, `Bullet só de QA ${block.id}`, 'aprovado', ['qa']);
    }
    const approved = reapprove(model);
    const dev = resolve(approved, 'desenvolvimento');
    expect(dev.projects.entries.map((e) => e.id)).not.toContain('proj-notasfacil');
    expect(dev.manifest.omitted.entriesWithoutApprovedBullets).toContain('proj-notasfacil');
    const qa = resolve(approved, 'qa');
    expect(qa.projects.entries.map((e) => e.id)).toContain('proj-notasfacil');
    expect(JSON.stringify(dev)).not.toContain('Bullet só de QA');
  });
});

describe('exige aprovação integral válida e fidelidade ao PDF', () => {
  it('modelo sem approval é recusado', () => {
    const model = approvedModel();
    delete model.approval;
    expect(failure(() => resolve(model)).code).toBe('NOT_APPROVED');
  });

  it('aprovação obsoleta após mudança de conteúdo é recusada', () => {
    const model = approvedModel();
    const bullet = must(must(model.experience[0]).bullets[1]?.variants[0]);
    bullet.text = `${bullet.text} (alterado depois da aprovação)`;
    const error = failure(() => resolve(model));
    expect(error.code).toBe('STALE_APPROVAL');
    expect(error.details.join(' ')).toContain(must(model.approval).modelHash);
  });

  it('a mudança de qualquer campo curado também invalida a aprovação', () => {
    const model = approvedModel();
    must(entryById(model, 'exp-oficina-exemplo-ltda').curated).title = 'Outro título';
    expect(failure(() => resolve(model)).code).toBe('STALE_APPROVAL');
    const links = approvedModel();
    must(links.identity.links[0]).confirmedByUser = true;
    expect(failure(() => resolve(links)).code).toBe('STALE_APPROVAL');
  });

  it('bloco sem nenhuma variante aprovada impede a aprovação integral', () => {
    const model = approvedModel();
    for (const v of must(model.experience[0]?.bullets[0]).variants) {
      v.status = 'rascunho';
      delete v.approvedAt;
    }
    expect(failure(() => resolve(reapprove(model))).code).toBe('NOT_APPROVED');
  });

  it('PDF diferente do registrado ou texto do PDF alterado: fidelidade falha', async () => {
    const other = await extractPdfBytes(
      await makeFictionalMasterPdf({
        mutate: (lines) => {
          const first = lines[1];
          if (first) lines[1] = { ...first, text: `${first.text} (outro PDF)` };
        },
      }),
      'outro.pdf',
    );
    const error = failure(() => resolveResume(approvedModel(), { extraction: other }));
    expect(error.code).toBe('FIDELITY_FAILED');

    const tampered = approvedModel();
    const original = must(tampered.summary.variants[0]);
    original.text = `${original.text} Acréscimo inventado.`;
    expect(failure(() => resolve(reapprove(tampered))).code).toBe('FIDELITY_FAILED');
  });
});

describe('campos curados vencem os originais', () => {
  it('título, tecnologias, skills e títulos de seção usam o curated; sem curated, o original', () => {
    const model = approvedModel();
    const r = resolve(model);
    const oficina = must(r.experience.entries.find((e) => e.id === 'exp-oficina-exemplo-ltda'));
    expect(oficina.title).toBe('Oficina Exemplo — título curado');
    expect(oficina.technologies).toEqual(['React', 'IndexedDB']);
    const agenda = must(r.experience.entries.find((e) => e.id === 'exp-agendamais'));
    const agendaOriginal = entryById(model, 'exp-agendamais');
    expect(agenda.title).toBe(agendaOriginal.title);
    expect(agenda.technologies).toEqual(agendaOriginal.technologies);
    expect(r.skills[1]?.text).toBe(`${must(model.skills[1]).category}: Vitest, Playwright`);
    expect(r.skills[0]?.text).toBe(must(model.skills[0]).text);
    expect(r.experience.title).toBe('Experiência em projetos');
    expect(r.projects.title).toBe('Outros projetos');
  });

  it('sem sectionTitles, usa os títulos do PDF', () => {
    const model = approvedModel();
    delete model.sectionTitles;
    const r = resolve(reapprove(model));
    expect(r.experience.title).toBe('Experiência profissional');
    expect(r.projects.title).toBe('Projetos');
  });

  it('acessores effective* informam a origem e a base do campo curado', () => {
    const model = approvedModel();
    const entry = entryById(model, 'exp-oficina-exemplo-ltda');
    expect(effectiveEntryTitle(entry)).toMatchObject({ source: 'curated', approvedAt: DAY });
    expect(effectiveEntryTechnologies(entry).source).toBe('curated');
    expect(effectiveEntryTitle(entryById(model, 'exp-agendamais')).source).toBe('original');
    expect(effectiveSkill(must(model.skills[1]))).toMatchObject({ source: 'curated' });
    expect(effectiveSkill(must(model.skills[0]))).toMatchObject({ source: 'original' });
    expect(effectiveSectionTitles(model).experience.source).toBe('curated');
    expect(effectiveCertification(must(model.certifications[0]))?.source).toBe('curated');
  });

  it('o manifesto registra a origem dos campos curados (e das bases)', () => {
    const r = resolve(approvedModel());
    const title = r.manifest.fields.find((f) => f.field === 'exp-oficina-exemplo-ltda.title');
    expect(title).toEqual({
      field: 'exp-oficina-exemplo-ltda.title',
      source: 'curated',
      approvedAt: DAY,
      basis: [{ kind: 'decisao_proprietario', ref: 'conversa' }],
    });
    expect(r.manifest.fields.find((f) => f.field === 'exp-agendamais.title')).toEqual({
      field: 'exp-agendamais.title',
      source: 'original',
    });
    expect(r.manifest.fields.some((f) => f.field === 'sectionTitles.experience')).toBe(true);
  });
});

describe('textos antigos, rascunhos, rejeitados e informação retida nunca saem', () => {
  it('nada do PDF superado, de rascunho ou de variante rejeitada aparece no currículo', () => {
    const model = approvedModel();
    const out = JSON.stringify(resolve(model));
    expect(out).not.toContain(SENTINEL_DRAFT);
    expect(out).not.toContain(SENTINEL_REJECTED);
    // Texto do PDF das variantes que foram substituídas pelas editadas.
    for (const id of ['exp-oficina-exemplo-ltda-b1', 'exp-agendamais-b1']) {
      const block = must(
        [...model.experience, ...model.projects].flatMap((e) => e.bullets).find((b) => b.id === id),
      );
      expect(out).not.toContain(must(block.variants[0]).text);
    }
    expect(out).not.toContain(must(model.summary.variants[0]).text);
    expect(out).not.toContain('cerca de 90 pessoas');
    // Tecnologia que só existe no original da entrada curada (a curada troca por IndexedDB).
    const oficina = must(
      resolve(model).experience.entries.find((e) => e.id === 'exp-oficina-exemplo-ltda'),
    );
    expect(oficina.technologies).not.toContain('Node.js');
    expect(oficina.technologies).not.toContain('Prisma ORM');
  });

  it('certificação: somente curated.text, sem ano nem descrição', () => {
    const model = approvedModel();
    const cert = must(model.certifications[0]);
    const r = resolve(model);
    expect(r.certifications).toEqual(['Fundamentos de APIs REST — Instituto Exemplo']);
    expect(r.certifications.join()).not.toContain(String(cert.year));
    expect(JSON.stringify(r)).not.toContain(must(cert.description));
    expect(JSON.stringify(r)).not.toContain(cert.text);
  });

  it('certificação sem curadoria não entra (o PDF traz ano e descrição)', () => {
    const model = approvedModel();
    delete must(model.certifications[0]).curated;
    const r = resolve(reapprove(model));
    expect(r.certifications).toEqual([]);
    expect(r.manifest.omitted.certificationsWithoutCuratedText).toEqual([
      'cert-fundamentos-de-apis-rest',
    ]);
    expect(effectiveCertification(must(model.certifications[0]))).toBeUndefined();
  });

  it('descrição ou ano retidos dentro de qualquer campo emitido: falha FORBIDDEN_CONTENT', () => {
    const withDescription = approvedModel();
    const cert = must(withDescription.certifications[0]);
    must(cert.curated).text = `${cert.title} — ${must(cert.description)}`;
    expect(failure(() => resolve(reapprove(withDescription))).code).toBe('FORBIDDEN_CONTENT');

    const withYear = approvedModel();
    const c2 = must(withYear.certifications[0]);
    must(c2.curated).text = `${c2.title} (${c2.year})`;
    expect(failure(() => resolve(reapprove(withYear))).code).toBe('FORBIDDEN_CONTENT');

    const inBullet = approvedModel();
    const desc = must(must(inBullet.certifications[0]).description);
    const edited = must(
      must(entryById(inBullet, 'exp-oficina-exemplo-ltda').bullets[0]).variants.find((v) =>
        v.id.endsWith('-editada'),
      ),
    );
    edited.text = `Mantenho a plataforma. ${desc}`;
    expect(failure(() => resolve(reapprove(inBullet))).code).toBe('FORBIDDEN_CONTENT');
  });

  it('frases de afirmações rejeitadas não podem aparecer; trechos também confirmados são liberados', () => {
    const model = approvedModel();
    model.claims = [
      {
        id: 'claim-rejeitada-1',
        blockId: 'x',
        kind: 'producao_comercial',
        quote: 'em produção · frase banida zzz',
        question: 'q',
        status: 'rejeitada',
        resolution: { at: DAY, by: 'proprietario', note: 'rejeitada', basis: [] },
      },
      {
        id: 'claim-confirmada-1',
        blockId: 'y',
        kind: 'producao_comercial',
        quote: 'em produção · outra coisa',
        question: 'q',
        status: 'confirmada',
        resolution: { at: DAY, by: 'proprietario', note: 'ok', basis: [] },
      },
    ];
    expect(bannedPhrases(model)).toEqual(['frase banida zzz']);
    expect(resolve(model).summary).toBe(GENERIC); // "em produção" não é banida

    const edited = must(
      must(entryById(model, 'exp-oficina-exemplo-ltda').bullets[1]).variants.find((v) =>
        v.id.endsWith('-draft'),
      ),
    );
    edited.text = 'texto qualquer';
    const bullet = must(entryById(model, 'exp-oficina-exemplo-ltda').bullets[1]);
    addVariant(bullet, 'b2-com-frase-banida', 'Contém a Frase Banida ZZZ.', 'aprovado');
    must(bullet.variants[0]).status = 'rascunho';
    delete must(bullet.variants[0]).approvedAt;
    const error = failure(() => resolve(reapprove(model)));
    expect(error.code).toBe('FORBIDDEN_CONTENT');
    expect(error.details.join()).toContain('frase banida zzz');
  });
});

describe('links: somente os confirmados pelo proprietário', () => {
  it('link não confirmado fica de fora e é registrado no manifesto', () => {
    const r = resolve(approvedModel());
    expect(r.header.links.map((l) => l.id)).toEqual(['link-github', 'link-portfolio']);
    expect(r.manifest.omitted.linksNotConfirmed).toEqual(['link-linkedin']);
    expect(JSON.stringify(r)).not.toContain('maria-exemplo-/');
    expect(r.manifest.links).not.toContain('link-linkedin');
    expect(r.manifest.links).toContain('link-github');
  });

  it('confirmedByUser sem aprovação (ou aprovação sem confirmação) também exclui o link', () => {
    const model = approvedModel();
    const [github, portfolio] = [must(model.identity.links[1]), must(model.identity.links[2])];
    github.status = 'rascunho';
    delete github.approvedAt;
    portfolio.confirmedByUser = false;
    const r = resolve(reapprove(model));
    expect(r.header.links).toEqual([]);
    expect(r.manifest.omitted.linksNotConfirmed).toEqual(
      expect.arrayContaining(['link-linkedin', 'link-github', 'link-portfolio']),
    );
  });

  it('link de projeto não confirmado é excluído da entrada', () => {
    const model = approvedModel();
    const link = must(entryById(model, 'exp-agendamais').links[0]);
    link.confirmedByUser = false;
    const r = resolve(reapprove(model));
    const entry = must(r.experience.entries.find((e) => e.id === 'exp-agendamais'));
    expect(entry.links.map((l) => l.id)).not.toContain(link.id);
    expect(entry.links.length).toBe(entryById(model, 'exp-agendamais').links.length - 1);
  });
});

describe('números de usuários declarados', () => {
  it('preserva "aproximadamente X pessoas" e descarta a redação antiga do PDF', () => {
    const model = approvedModel();
    const r = resolve(model);
    const bullets = [...r.experience.entries, ...r.projects.entries].flatMap((e) => e.bullets);
    const counts = bullets.flatMap((b) =>
      [...b.matchAll(/aproximadamente (\d+) pessoas/g)].map((m) => m[1]),
    );
    expect(counts).toEqual(['40', '25']);
    expect(bullets.join(' ')).not.toMatch(/em média por|usada? por \d+/i);
    expect(r.summary).not.toMatch(/\d+ pessoas/);
  });
});

describe('determinismo e rastreabilidade', () => {
  it('a mesma entrada gera exatamente a mesma saída (sem datas nem aleatoriedade)', () => {
    const model = approvedModel();
    const a = resolve(model, 'qa');
    const b = resolve(model, 'qa');
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.manifest.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolve(model, 'desenvolvimento').manifest.contentSha256).not.toBe(
      a.manifest.contentSha256,
    );
  });

  it('não modifica o modelo', () => {
    const model = approvedModel();
    const before = JSON.stringify(model);
    resolve(model);
    resolve(model, 'qa');
    expect(JSON.stringify(model)).toBe(before);
  });

  it('o manifesto traz hash do modelo, área, variantes usadas e fidelidade', () => {
    const model = approvedModel();
    const { manifest } = resolve(model, 'qa');
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      modelHash: must(model.approval).modelHash,
      approvedAt: DAY,
      masterSha256: model.master.sha256,
      area: 'qa',
      fidelity: 'fiel',
    });
    const ids = manifest.variants.map((v) => v.variantId);
    expect(ids).toContain('resumo-qa');
    expect(ids).toContain('headline-mestre');
    expect(ids).toContain('exp-oficina-exemplo-ltda-b1-editada');
    expect(ids).not.toContain('resumo-geral');
    expect(ids.some((id) => id.endsWith('-draft') || id.endsWith('-rej'))).toBe(false);
    const edited = manifest.variants.find((v) => v.variantId === 'resumo-qa');
    expect(edited?.derivedFrom).toBe(must(model.summary.variants[0]).id);
    // Sem texto pessoal no manifesto: só ids, hashes e referências.
    expect(JSON.stringify(manifest)).not.toContain(GENERIC);
    expect(JSON.stringify(manifest)).not.toContain(model.identity.name.value);
  });
});
