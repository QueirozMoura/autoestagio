import { bannedPhrases, isConfirmedLink } from './resolve.js';
import type { CvMaster } from './schema.js';
import type { ForbiddenSet } from './validate/forbidden.js';

export class StrictContextError extends Error {
  constructor(readonly code: 'FORBIDDEN_CONTEXT' | 'LOCAL_CONTEXT' | 'DECLARATIONS') {
    super(`Contexto obrigatório insuficiente: ${code}.`);
    this.name = 'StrictContextError';
  }
}

const normalize = (text: string): string => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
const sufficient = (text: string): boolean => {
  const value = normalize(text);
  return value.length >= 12 && value.split(' ').length >= 2 && /\p{L}{3,}/u.test(value);
};

/** Derivação interna: o fluxo estrito não recebe ForbiddenSet nem exceções do chamador. */
export function deriveForbiddenSet(model: CvMaster): ForbiddenSet {
  const phrases = bannedPhrases(model);
  const blocks = [
    model.identity.headline,
    model.summary,
    ...model.experience.flatMap((e) => e.bullets),
    ...model.projects.flatMap((e) => e.bullets),
  ];
  const approved = new Set(
    blocks.flatMap((b) =>
      b.variants
        .filter((v) => v.status === 'aprovado' && v.approvedAt !== undefined)
        .map((v) => normalize(v.text)),
    ),
  );
  for (const block of blocks)
    for (const variant of block.variants)
      if (variant.status !== 'aprovado' && !approved.has(normalize(variant.text)))
        phrases.push(variant.text);
  for (const claim of model.claims.filter((c) => c.status === 'rejeitada')) {
    if (!sufficient(claim.quote)) throw new StrictContextError('FORBIDDEN_CONTEXT');
  }
  if (
    phrases.some(
      (p) =>
        normalize(p).length === 0 ||
        (normalize(p).split(' ').length < 2 && normalize(p).length < 10),
    )
  )
    throw new StrictContextError('FORBIDDEN_CONTEXT');
  const retained: ForbiddenSet['retained'] = [];
  for (const cert of model.certifications) {
    if (cert.curated === undefined) {
      if (!sufficient(cert.text)) throw new StrictContextError('FORBIDDEN_CONTEXT');
      retained.push({ label: `${cert.id}: sem curadoria`, contexts: [cert.text] });
      continue;
    }
    if (cert.curated.withheld.includes('description')) {
      if (cert.description === undefined || !sufficient(cert.description))
        throw new StrictContextError('FORBIDDEN_CONTEXT');
      retained.push({ label: `${cert.id}: descrição`, contexts: [cert.description] });
    }
    if (cert.curated.withheld.includes('year')) {
      const label = `${cert.curated.title} — ${cert.curated.issuer}`;
      const contexts = [
        cert.text,
        `${label} (${cert.year})`,
        `${label} ${cert.year}`,
        `${label} | ${cert.year}`,
        `${label} — ${cert.year}`,
        `${cert.title} ${cert.year}`,
      ];
      if (contexts.some((c) => !sufficient(c))) throw new StrictContextError('FORBIDDEN_CONTEXT');
      retained.push({ label: `${cert.id}: ano`, contexts: [...new Set(contexts)] });
    }
  }
  return {
    phrases: [...new Set(phrases)].sort(),
    urls: [
      ...new Set(
        [
          ...model.identity.links,
          ...model.experience.flatMap((e) => e.links),
          ...model.projects.flatMap((e) => e.links),
        ]
          .filter((l) => !isConfirmedLink(l))
          .map((l) => l.url),
      ),
    ].sort(),
    retained,
  };
}

export interface LocalContext {
  projectRoot: string;
  userName: string;
  hostName: string;
}
export function localMarkers(input: unknown): string[] {
  if (input === null || typeof input !== 'object') throw new StrictContextError('LOCAL_CONTEXT');
  const context = input as Partial<LocalContext>;
  const markers = [context.projectRoot, context.userName, context.hostName];
  if (
    markers.some((m) => typeof m !== 'string' || m.trim().length < 2) ||
    !/^(\/|[a-z]:[\\/]|\\\\)/iu.test(context.projectRoot ?? '')
  )
    throw new StrictContextError('LOCAL_CONTEXT');
  return markers.map((m) => (m ?? '').trim());
}
