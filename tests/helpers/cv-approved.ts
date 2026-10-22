import type { CvMaster } from '../../src/cv/index.js';
import { modelHash } from '../../src/cv/index.js';
import type { Entry } from '../../src/cv/schema.js';
import type { Loaded } from './cv-fixture.js';

export const DAY = '2026-10-22';
export const BASIS = [{ kind: 'decisao_proprietario', ref: 'conversa', note: 'teste' }] as const;
export const GENERIC = 'Resumo genérico aprovado, sem área.';
export const DEV = 'Resumo aprovado de Desenvolvimento.';
export const QA = 'Resumo aprovado de QA.';
export const SENTINEL_DRAFT = 'TEXTO-EM-RASCUNHO-NAO-PODE-SAIR';
export const SENTINEL_REJECTED = 'TEXTO-REJEITADO-NAO-PODE-SAIR';

export const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('valor ausente no teste');
  return value;
};
export type Block = CvMaster['summary'];
export type VariantT = Block['variants'][number];

export function approveVariant(v: VariantT): void {
  v.status = 'aprovado';
  v.approvedAt = DAY;
}
export function addVariant(
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
export const entryById = (m: CvMaster, id: string): Entry =>
  must([...m.experience, ...m.projects].find((e) => e.id === id));
export const reapprove = (m: CvMaster): CvMaster => ({
  ...m,
  approval: { approvedAt: DAY, modelHash: modelHash(m) },
});

/** Modelo fictício aprovado: resumos genérico/Dev/QA, curadoria, links confirmados (menos o LinkedIn). */
export function approvedModel(L: Loaded): CvMaster {
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
