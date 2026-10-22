import { createHash } from 'node:crypto';
import type { Area } from '../eligibility/areas.js';
import { fidelityReport } from './fidelity.js';
import type { PdfExtraction } from './pdf.js';
import {
  canonicalJson,
  modelHash,
  type Basis,
  type CvLink,
  type CvMaster,
  type Entry,
} from './schema.js';
import {
  MissingApprovedVariantError,
  isModelFullyApproved,
  requiredBlocksWithoutApproval,
  selectVariant,
  type Variant,
} from './selection.js';

/**
 * Etapa 4.2 — resolução segura e determinística do conteúdo do currículo.
 *
 * Transforma o modelo mestre APROVADO em um currículo resolvido (estrutura intermediária, sem PDF) mais um
 * manifesto de rastreabilidade. Regras:
 *  - exige aprovação integral válida para o conteúdo atual e fidelidade ao PDF original;
 *  - campos curados vencem os originais; a certificação usa SOMENTE `curated.text`;
 *  - resumo e bullets vêm só de variantes aprovadas, pela seleção estrita por área (sem fallback);
 *  - só links confirmados pelo proprietário;
 *  - rascunho, rejeitado, informação retida e frases de afirmações rejeitadas nunca saem;
 *  - determinístico: sem data, sem aleatoriedade; a mesma entrada gera exatamente a mesma saída.
 * Nada aqui lê rede, grava arquivo ou gera PDF.
 */

export type ResolveErrorCode =
  | 'NOT_APPROVED'
  | 'STALE_APPROVAL'
  | 'FIDELITY_FAILED'
  | 'MISSING_APPROVED_VARIANT'
  | 'FORBIDDEN_CONTENT';

/** Falha controlada: o currículo NÃO é montado (nunca é montado pela metade). */
export class ResumeResolutionError extends Error {
  constructor(
    readonly code: ResolveErrorCode,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ResumeResolutionError';
  }
}

export interface ResolvedLink {
  id: string;
  label: string;
  url: string;
}

export interface ResolvedEntry {
  id: string;
  title: string;
  period?: string;
  bullets: string[];
  technologies: string[];
  links: ResolvedLink[];
}

export interface ResolvedSkill {
  category: string;
  items: string[];
  text: string;
}

export interface ResolvedSection {
  title: string;
  entries: ResolvedEntry[];
}

export interface ManifestVariant {
  blockId: string;
  variantId: string;
  origin: 'mestre' | 'editada';
  derivedFrom?: string;
}

export interface ManifestField {
  field: string;
  source: 'curated' | 'original';
  /** Só nos campos curados: quando foi aprovado e a base (declaração ou evidência) de cada alteração. */
  approvedAt?: string;
  basis?: { kind: Basis['kind']; ref: string }[];
}

export interface ResumeManifest {
  schemaVersion: 1;
  modelHash: string;
  approvedAt: string;
  masterSha256: string;
  /** `null` = sem área (resumo genérico). */
  area: Area | null;
  fidelity: 'fiel';
  variants: ManifestVariant[];
  fields: ManifestField[];
  links: string[];
  omitted: {
    linksNotConfirmed: string[];
    entriesWithoutApprovedBullets: string[];
    certificationsWithoutCuratedText: string[];
  };
  /** SHA-256 do conteúdo resolvido (sem o manifesto): prova que o PDF futuro veio deste conteúdo. */
  contentSha256: string;
}

export interface ResolvedResume {
  language: 'pt-BR';
  area: Area | null;
  header: {
    name: string;
    headline: string;
    location: string;
    contacts: { kind: 'email' | 'telefone'; value: string }[];
    links: ResolvedLink[];
  };
  summary: string;
  experience: ResolvedSection;
  projects: ResolvedSection;
  skills: ResolvedSkill[];
  education: string[];
  languages: string[];
  certifications: string[];
  manifest: ResumeManifest;
}

// ------------------------------------------------------------------ acessores effective*

export interface Effective<T> {
  value: T;
  source: 'curated' | 'original';
  approvedAt?: string;
  basis?: Basis[];
}

const curatedOf = <T>(value: T, stamp: { approvedAt: string; basis: Basis[] }): Effective<T> => ({
  value,
  source: 'curated',
  approvedAt: stamp.approvedAt,
  basis: stamp.basis,
});
const originalOf = <T>(value: T): Effective<T> => ({ value, source: 'original' });

export function effectiveEntryTitle(entry: Entry): Effective<string> {
  return entry.curated?.title !== undefined
    ? curatedOf(entry.curated.title, entry.curated)
    : originalOf(entry.title);
}

export function effectiveEntryTechnologies(entry: Entry): Effective<string[]> {
  return entry.curated?.technologies !== undefined
    ? curatedOf([...entry.curated.technologies], entry.curated)
    : originalOf([...entry.technologies]);
}

export function effectiveSkill(skill: CvMaster['skills'][number]): Effective<ResolvedSkill> {
  return skill.curated !== undefined
    ? curatedOf(
        { category: skill.category, items: [...skill.curated.items], text: skill.curated.text },
        skill.curated,
      )
    : originalOf({ category: skill.category, items: [...skill.items], text: skill.text });
}

/** Certificação: EXCLUSIVAMENTE `curated.text`. Sem curadoria, a certificação não entra (o PDF traz ano e descrição). */
export function effectiveCertification(
  certification: CvMaster['certifications'][number],
): Effective<string> | undefined {
  return certification.curated === undefined
    ? undefined
    : curatedOf(certification.curated.text, certification.curated);
}

/** Títulos que o PDF mestre usa para as duas seções. */
export const ORIGINAL_SECTION_TITLES = {
  experience: 'Experiência profissional',
  projects: 'Projetos',
} as const;

export function effectiveSectionTitles(model: CvMaster): {
  experience: Effective<string>;
  projects: Effective<string>;
} {
  const titles = model.sectionTitles;
  return titles === undefined
    ? {
        experience: originalOf(ORIGINAL_SECTION_TITLES.experience),
        projects: originalOf(ORIGINAL_SECTION_TITLES.projects),
      }
    : {
        experience: curatedOf(titles.experience, titles),
        projects: curatedOf(titles.projects, titles),
      };
}

/** Só links confirmados pelo proprietário (confirmedByUser + aprovado com data). */
export const isConfirmedLink = (link: CvLink): boolean =>
  link.confirmedByUser && link.status === 'aprovado' && link.approvedAt !== undefined;

export const confirmedLinks = (links: CvLink[]): ResolvedLink[] =>
  links.filter(isConfirmedLink).map((l) => ({ id: l.id, label: l.label, url: l.url }));

// ------------------------------------------------------------------ guardas

/**
 * Frases de afirmações REJEITADAS que não podem aparecer no currículo. Partes (separadas por " · ") que
 * também pertencem a uma afirmação confirmada ficam de fora (ex.: "em produção" é legítimo na JFQ).
 */
export function bannedPhrases(model: CvMaster): string[] {
  const pieces = (quote: string): string[] =>
    quote
      .split(' · ')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 3);
  const confirmed = new Set(
    model.claims.filter((c) => c.status === 'confirmada').flatMap((c) => pieces(c.quote)),
  );
  const banned = new Set(
    model.claims
      .filter((c) => c.status === 'rejeitada')
      .flatMap((c) => pieces(c.quote))
      .filter((p) => !confirmed.has(p)),
  );
  return [...banned].sort();
}

function allEmittedTexts(resume: Omit<ResolvedResume, 'manifest'>): string[] {
  const entryTexts = (s: ResolvedSection): string[] => [
    s.title,
    ...s.entries.flatMap((e) => [e.title, e.period ?? '', ...e.bullets, ...e.technologies]),
  ];
  return [
    resume.header.name,
    resume.header.headline,
    resume.header.location,
    ...resume.header.contacts.map((c) => c.value),
    resume.summary,
    ...entryTexts(resume.experience),
    ...entryTexts(resume.projects),
    ...resume.skills.flatMap((s) => [s.category, s.text, ...s.items]),
    ...resume.education,
    ...resume.languages,
    ...resume.certifications,
  ];
}

function assertNoForbiddenContent(model: CvMaster, resume: Omit<ResolvedResume, 'manifest'>): void {
  const problems: string[] = [];
  const texts = allEmittedTexts(resume);
  const haystack = texts.join('\n').toLowerCase();
  for (const phrase of bannedPhrases(model))
    if (haystack.includes(phrase))
      problems.push(`frase de afirmação rejeitada no currículo: "${phrase}"`);
  for (const cert of model.certifications) {
    // O que o curated retém (ano e descrição do PDF) nunca sai, nem dentro de outro campo.
    if (cert.curated === undefined) continue;
    if (cert.curated.withheld.includes('description') && cert.description !== undefined)
      if (haystack.includes(cert.description.toLowerCase()))
        problems.push(`descrição retida da certificação "${cert.title}" no currículo`);
    if (cert.curated.withheld.includes('year'))
      for (const text of resume.certifications)
        if (text.includes(String(cert.year)))
          problems.push(`ano retido da certificação "${cert.title}" no currículo`);
  }
  if (problems.length > 0)
    throw new ResumeResolutionError(
      'FORBIDDEN_CONTENT',
      'O currículo resolvido contém conteúdo proibido.',
      problems,
    );
}

function assertResolvable(model: CvMaster, extraction: PdfExtraction): void {
  if (model.approval === undefined)
    throw new ResumeResolutionError('NOT_APPROVED', 'O modelo mestre não está aprovado.');
  if (model.approval.modelHash !== modelHash(model))
    throw new ResumeResolutionError(
      'STALE_APPROVAL',
      'A aprovação está obsoleta: o conteúdo do modelo mudou depois de aprovado.',
      [`aprovado: ${model.approval.modelHash}`, `atual:    ${modelHash(model)}`],
    );
  if (!isModelFullyApproved(model))
    throw new ResumeResolutionError(
      'NOT_APPROVED',
      'Há bloco sem nenhuma variante aprovada: o modelo não está integralmente aprovado.',
    );
  const fidelity = fidelityReport(model, extraction);
  if (fidelity.verdict !== 'fiel')
    throw new ResumeResolutionError(
      'FIDELITY_FAILED',
      'O modelo não é fiel ao PDF mestre informado.',
      [
        ...(fidelity.masterSha256.matches ? [] : ['SHA-256 do PDF difere do registrado no modelo']),
        ...fidelity.blocks.missing.map((m) => `bloco ausente do PDF: ${m.id}`),
        ...fidelity.derivedFields.invalid,
        ...fidelity.links.mismatches,
      ],
    );
}

// ------------------------------------------------------------------ resolução

export interface ResolveOptions {
  /** Ausente = sem área (resumo genérico). Com área: só o resumo aprovado daquela área. */
  area?: Area;
  /** O PDF mestre extraído: a fidelidade é conferida a cada resolução. */
  extraction: PdfExtraction;
}

export function resolveResume(model: CvMaster, options: ResolveOptions): ResolvedResume {
  const { area, extraction } = options;
  assertResolvable(model, extraction);
  const approval = model.approval;
  if (approval === undefined) throw new ResumeResolutionError('NOT_APPROVED', 'Sem aprovação.');

  const missing = requiredBlocksWithoutApproval(model, area);
  if (missing.length > 0) {
    const error = new MissingApprovedVariantError(missing);
    throw new ResumeResolutionError(
      'MISSING_APPROVED_VARIANT',
      area === undefined
        ? error.message
        : `${error.message} (área "${area}": não há fallback para o resumo genérico)`,
      missing,
    );
  }

  const variants: ManifestVariant[] = [];
  const fields: ManifestField[] = [];
  const omitted: ResumeManifest['omitted'] = {
    linksNotConfirmed: [],
    entriesWithoutApprovedBullets: [],
    certificationsWithoutCuratedText: [],
  };
  const use = (blockId: string, variant: Variant): string => {
    variants.push({
      blockId,
      variantId: variant.id,
      origin: variant.origin,
      ...(variant.derivedFrom === undefined ? {} : { derivedFrom: variant.derivedFrom }),
    });
    return variant.text;
  };
  const track = (field: string, effective: Effective<unknown>): void => {
    fields.push({
      field,
      source: effective.source,
      ...(effective.source === 'curated' && effective.approvedAt !== undefined
        ? {
            approvedAt: effective.approvedAt,
            basis: (effective.basis ?? []).map((b) => ({ kind: b.kind, ref: b.ref })),
          }
        : {}),
    });
  };
  const links = (list: CvLink[]): ResolvedLink[] => {
    for (const l of list) if (!isConfirmedLink(l)) omitted.linksNotConfirmed.push(l.id);
    return confirmedLinks(list);
  };

  const headlineVariant = selectVariant(model.identity.headline, area);
  const summaryVariant = selectVariant(model.summary, area);
  if (headlineVariant === undefined || summaryVariant === undefined)
    throw new ResumeResolutionError(
      'MISSING_APPROVED_VARIANT',
      'Cabeçalho ou resumo sem variante.',
    );

  const header = {
    name: model.identity.name.value,
    headline: use(model.identity.headline.id, headlineVariant),
    location: model.identity.location.value,
    contacts: model.identity.contacts.map((c) => ({ kind: c.kind, value: c.value })),
    links: links(model.identity.links),
  };
  const summary = use(model.summary.id, summaryVariant);

  const resolveEntry = (entry: Entry): ResolvedEntry | undefined => {
    const bullets: string[] = [];
    for (const block of entry.bullets) {
      const variant = selectVariant(block, area);
      if (variant !== undefined) bullets.push(use(block.id, variant));
    }
    if (bullets.length === 0) {
      omitted.entriesWithoutApprovedBullets.push(entry.id);
      return undefined;
    }
    const title = effectiveEntryTitle(entry);
    const technologies = effectiveEntryTechnologies(entry);
    track(`${entry.id}.title`, title);
    track(`${entry.id}.technologies`, technologies);
    return {
      id: entry.id,
      title: title.value,
      ...(entry.period === undefined ? {} : { period: entry.period.label }),
      bullets,
      technologies: technologies.value,
      links: links(entry.links),
    };
  };
  const section = (title: Effective<string>, name: string, list: Entry[]): ResolvedSection => {
    track(`sectionTitles.${name}`, title);
    return {
      title: title.value,
      entries: list.map(resolveEntry).filter((e): e is ResolvedEntry => e !== undefined),
    };
  };
  const titles = effectiveSectionTitles(model);

  const skills = model.skills.map((s) => {
    const effective = effectiveSkill(s);
    track(s.id, effective);
    return effective.value;
  });
  const certifications: string[] = [];
  for (const cert of model.certifications) {
    const effective = effectiveCertification(cert);
    if (effective === undefined) omitted.certificationsWithoutCuratedText.push(cert.id);
    else {
      certifications.push(effective.value);
      track(cert.id, effective);
    }
  }

  const base = {
    language: 'pt-BR' as const,
    area: area ?? null,
    header,
    summary,
    experience: section(titles.experience, 'experience', model.experience),
    projects: section(titles.projects, 'projects', model.projects),
    skills,
    education: model.education.map((e) => e.text),
    languages: model.languages.map((l) => l.text),
    certifications,
  };
  assertNoForbiddenContent(model, base);

  const included = new Set<string>([
    ...header.links.map((l) => l.id),
    ...base.experience.entries.flatMap((e) => e.links.map((l) => l.id)),
    ...base.projects.entries.flatMap((e) => e.links.map((l) => l.id)),
  ]);
  const manifest: ResumeManifest = {
    schemaVersion: 1,
    modelHash: approval.modelHash,
    approvedAt: approval.approvedAt,
    masterSha256: model.master.sha256,
    area: area ?? null,
    fidelity: 'fiel',
    variants,
    fields,
    links: [...included].sort(),
    omitted: {
      linksNotConfirmed: [...new Set(omitted.linksNotConfirmed)].sort(),
      entriesWithoutApprovedBullets: omitted.entriesWithoutApprovedBullets,
      certificationsWithoutCuratedText: omitted.certificationsWithoutCuratedText,
    },
    contentSha256: createHash('sha256').update(canonicalJson(base)).digest('hex'),
  };
  return { ...base, manifest };
}

export type TryResolveResult =
  { ok: true; resume: ResolvedResume } | { ok: false; error: ResumeResolutionError };

/** Variante da resolução para pipelines: falha controlada em vez de exceção (outros erros continuam subindo). */
export function tryResolveResume(model: CvMaster, options: ResolveOptions): TryResolveResult {
  try {
    return { ok: true, resume: resolveResume(model, options) };
  } catch (error) {
    if (error instanceof ResumeResolutionError) return { ok: false, error };
    throw error;
  }
}
