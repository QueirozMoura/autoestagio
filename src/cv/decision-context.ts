import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AREAS } from '../eligibility/areas.js';
import { canonicalJson, modelHash, type CvMaster } from './schema.js';
import type { ResolvedResume } from './resolve.js';
import { StrictContextError } from './strict-context.js';

export const decisionHash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(4096);
const list = z.array(text).max(200);
export const DECISION_LIMITS = {
  people: ['approximate', 'current-or-former', 'not-active', 'not-simultaneous', 'no-aggregation'],
  maintenance: ['historical-confirmation-only', 'not-continuity-proof'],
  sales: ['jfq-only', 'no-volume', 'no-recurrence', 'not-code-proof-of-sales'],
  name: ['resume-name-only'],
  link: ['exact-url-only', 'owner-manual-check', 'no-automated-proof'],
  certificate: [
    'presented-title-issuer-completion',
    'no-external-authentication',
    'no-year',
    'no-description',
    'no-workload',
    'no-professional-level',
    'no-specific-competencies',
  ],
  knowledge: [
    'declaratory-editorial-only',
    'no-level',
    'no-professional-experience',
    'no-duration',
    'no-certification',
    'no-technical-proof',
  ],
} as const;
for (const limits of Object.values(DECISION_LIMITS)) Object.freeze(limits);
Object.freeze(DECISION_LIMITS);
const scopeSchema = z.strictObject({
  kind: z.enum(['people', 'maintenance', 'sales', 'name', 'link', 'certificate', 'knowledge']),
  subject: text,
  limits: z.array(text).min(1).max(30),
});
const decisionSchema = z.strictObject({
  id: text,
  declarationId: text,
  assertion: text,
  scope: scopeSchema,
  assertionSha256: hash,
  mode: z.enum(['owner-confirmation', 'historical-recognition']),
  recordedAt: z.iso.datetime({ offset: true }),
  recordedBy: z.literal('codex'),
  sourceId: text,
  sourceKind: z.enum(['claim-resolution', 'editorial-decision', 'owner-message']),
  sourcePointer: z.string().max(4096),
  sourceSha256: hash,
  sourceText: text,
  sourceDate: z.iso.date(),
  // Reconhecer uma fonte não cria uma nova confirmação factual do proprietário.
  historicalOwner: z.literal('proprietario'),
});
const unitSchema = z.strictObject({ id: text, textSha256: hash, decisions: list, inherits: list });
export const decisionManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  modelHash: hash,
  modelSnapshotSha256: hash,
  declarationsSha256: hash,
  decisions: z.array(decisionSchema).max(200),
  variants: z
    .array(
      z.strictObject({
        area: z.enum(AREAS).nullable(),
        contentSha256: hash,
        units: z.array(unitSchema).max(2000),
      }),
    )
    .min(1)
    .max(10),
});
export type DecisionManifest = z.infer<typeof decisionManifestSchema>;
export type AtomicDecision = DecisionManifest['decisions'][number];
export interface DecisionTrustAnchor {
  manifestSha256: string;
  modelHash: string;
  /** Compromisso separado com as fontes revisadas; nunca é derivado do manifesto recebido. */
  sourcesSha256: string;
}
export interface DecisionContext {
  readonly kind: 'verified-decision-context';
}
interface State {
  manifest: DecisionManifest;
  manifestSha256: string;
  sourcesSha256: string;
}
const contexts = new WeakMap<DecisionContext, State>();
const fail = (): never => {
  throw new StrictContextError('DECLARATIONS');
};
const unique = (values: string[]): boolean => new Set(values).size === values.length;
/** Somente JSON, com limites antes da canonicalização ou cópia recursiva. */
function boundedJson(value: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 200000 || depth > 64) return fail();
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
    else if (value !== null && typeof value === 'object') {
      if (
        active.has(value) ||
        (!Array.isArray(value) &&
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null)
      )
        return fail();
      active.add(value);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if ('get' in descriptor || 'set' in descriptor) return fail();
        bytes += Buffer.byteLength(key, 'utf8');
        visit(descriptor.value as unknown, depth + 1);
      }
      active.delete(value);
    } else if (
      value !== null &&
      typeof value !== 'boolean' &&
      (typeof value !== 'number' || !Number.isFinite(value))
    )
      return fail();
    if (bytes > 8 * 1024 * 1024) return fail();
  };
  visit(value, 0);
}
const pointer = (value: unknown, path: string): unknown => {
  if (path === '') return value;
  if (!path.startsWith('/')) return fail();
  for (const segment of path.slice(1).split('/')) {
    const key = segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return fail();
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};
const sourceSchema = z
  .object({
    by: z.literal('proprietario'),
    at: z.iso.date().optional(),
    approvedAt: z.iso.date().optional(),
    text: text.optional(),
    note: text.optional(),
    editorialText: text.optional(),
    scope: z.union([scopeSchema, z.literal('editorial-documentary-only')]).optional(),
  })
  .loose();

/**
 * Fronteira de confiança: o chamador deve obter a âncora de um registro privado previamente
 * autorizado, separado do bundle não confiável. Hash não é assinatura ou prova de autoria.
 * Esta função verifica integridade e equivalência REVISTA, não interpreta linguagem natural.
 * Nenhum I/O ou aprovação é realizado. Fontes históricas são snapshots com ponteiros verificáveis.
 */
export function verifyDecisionContext(
  bundle: { manifest: unknown; sources: unknown },
  trusted: DecisionTrustAnchor,
): DecisionContext {
  boundedJson(bundle);
  const parsed = decisionManifestSchema.safeParse(structuredClone(bundle.manifest));
  if (!parsed.success) return fail();
  const manifest = parsed.data;
  const sources = z.record(z.string(), z.unknown()).safeParse(structuredClone(bundle.sources));
  if (
    !sources.success ||
    decisionHash(bundle.manifest) !== trusted.manifestSha256 ||
    decisionHash(sources.data) !== trusted.sourcesSha256 ||
    manifest.modelHash !== trusted.modelHash
  )
    return fail();
  if (
    !unique(manifest.decisions.map((d) => d.id)) ||
    !unique(
      manifest.decisions.map((d) =>
        canonicalJson([d.declarationId, d.scope.kind, d.scope.subject]),
      ),
    ) ||
    !unique(manifest.variants.map((v) => v.area ?? 'generic'))
  )
    return fail();
  for (const d of manifest.decisions) {
    if (
      decisionHash([...d.scope.limits].sort()) !==
      decisionHash([...DECISION_LIMITS[d.scope.kind]].sort())
    )
      return fail();
    if (
      decisionHash({ declarationId: d.declarationId, assertion: d.assertion, scope: d.scope }) !==
      d.assertionSha256
    )
      return fail();
    const source = sources.data[d.sourceId];
    if (source === undefined || decisionHash(source) !== d.sourceSha256) return fail();
    let raw = pointer(source, d.sourcePointer);
    if (d.sourceKind === 'claim-resolution') {
      if (raw === null || typeof raw !== 'object' || !('resolution' in raw)) return fail();
      const claim = raw as Record<string, unknown>;
      if (claim.status !== 'confirmada') return fail();
      raw = claim.resolution;
    }
    const s = sourceSchema.safeParse(raw);
    if (
      !s.success ||
      (s.data.at ?? s.data.approvedAt) !== d.sourceDate ||
      (s.data.text ?? s.data.note ?? s.data.editorialText) !== d.sourceText
    )
      return fail();
    if (
      d.mode === 'owner-confirmation' &&
      (d.sourceKind !== 'owner-message' ||
        s.data.text !== d.assertion ||
        s.data.scope === undefined ||
        decisionHash(s.data.scope) !== decisionHash(d.scope))
    )
      return fail();
    if (d.mode === 'historical-recognition' && d.sourceKind === 'owner-message') return fail();
    if (
      d.sourceKind === 'editorial-decision' &&
      (d.scope.kind !== 'certificate' || s.data.scope !== 'editorial-documentary-only')
    )
      return fail();
    // Fontes históricas são reconhecidas por correspondência exata com o trecho revisado;
    // o escopo revisado é comprometido pela âncora, sem inferência a partir do texto publicado.
    if (
      s.data.scope !== undefined &&
      typeof s.data.scope !== 'string' &&
      decisionHash(s.data.scope) !== decisionHash(d.scope)
    )
      return fail();
  }
  const units = new Map<string, z.infer<typeof unitSchema>>();
  for (const v of manifest.variants) {
    if (!unique(v.units.map((u) => u.id))) return fail();
    for (const u of v.units) {
      if (!unique(u.decisions) || !unique(u.inherits)) return fail();
      if (units.has(u.id) && decisionHash(units.get(u.id)) !== decisionHash(u)) return fail();
      units.set(u.id, u);
    }
  }
  const active = new Set<string>();
  const done = new Set<string>();
  let work = 0;
  const visit = (id: string, depth: number): void => {
    if (++work > 20000 || depth > 32 || active.has(id)) return fail();
    if (done.has(id)) return;
    const u = units.get(id);
    if (u === undefined) return fail();
    active.add(id);
    for (const parent of u.inherits) {
      const p = units.get(parent);
      if (p === undefined || p.textSha256 !== u.textSha256) return fail();
      visit(parent, depth + 1);
    }
    for (const id of u.decisions) if (!manifest.decisions.some((d) => d.id === id)) return fail();
    active.delete(id);
    done.add(id);
  };
  for (const id of units.keys()) visit(id, 0);
  const context: DecisionContext = Object.freeze({ kind: 'verified-decision-context' });
  contexts.set(context, {
    manifest,
    manifestSha256: trusted.manifestSha256,
    sourcesSha256: trusted.sourcesSha256,
  });
  return context;
}

export interface PublicationUnit {
  id: string;
  text: string;
  declarations: string[];
  inherits: string[];
}
/** Unidades com dependências editoriais; contentSha256 vincula também o restante do resolvido. */
export function publicationUnits(model: CvMaster, resume: ResolvedResume): PublicationUnit[] {
  const blocks = [
    model.identity.headline,
    model.summary,
    ...model.experience.flatMap((e) => e.bullets),
    ...model.projects.flatMap((e) => e.bullets),
  ];
  const variants = blocks.flatMap((b) => b.variants);
  const declarations = (basis: { kind: string; ref: string }[]): string[] => [
    ...new Set(
      basis
        .filter((b) => b.kind === 'declaracao_proprietario')
        .map((b) => b.ref.split('#')[1] ?? fail()),
    ),
  ];
  const units: PublicationUnit[] = [];
  const add = (id: string, text: string, refs: string[] = [], inherits: string[] = []): void => {
    units.push({ id, text, declarations: refs, inherits });
  };
  for (const used of resume.manifest.variants) {
    const v = variants.find((v) => v.id === used.variantId);
    if (v === undefined) return fail();
    const refs = declarations(v.basis);
    const parents =
      refs.length === 0
        ? variants.filter(
            (other) =>
              other.id !== v.id &&
              other.status === 'aprovado' &&
              other.text === v.text &&
              declarations(other.basis).length > 0,
          )
        : [];
    add(
      `variant:${v.id}`,
      v.text,
      refs,
      parents.map((p) => `variant:${p.id}`),
    );
  }
  for (const f of resume.manifest.fields) {
    let value: unknown;
    if (f.field === 'sectionTitles.experience') value = resume.experience.title;
    else if (f.field === 'sectionTitles.projects') value = resume.projects.title;
    else {
      const entry = [...resume.experience.entries, ...resume.projects.entries].find((e) =>
        f.field.startsWith(e.id + '.'),
      );
      const skillIndex = model.skills.findIndex((s) => s.id === f.field);
      const certIndex = model.certifications
        .filter((c) => c.curated !== undefined)
        .findIndex((c) => c.id === f.field);
      if (entry !== undefined)
        value = f.field.endsWith('.title') ? entry.title : entry.technologies;
      else if (skillIndex >= 0) value = resume.skills[skillIndex];
      else if (certIndex >= 0) value = resume.certifications[certIndex];
      else return fail();
    }
    add(
      `field:${f.field}`,
      typeof value === 'string' ? value : canonicalJson(value),
      declarations(f.basis ?? []),
    );
  }
  model.skills.forEach((s, i) => {
    resume.skills[i]?.items.forEach((item, j) => {
      add(`skill:${s.id}:${j}`, item);
    });
  });
  for (const link of [
    ...resume.header.links,
    ...resume.experience.entries.flatMap((e) => e.links),
    ...resume.projects.entries.flatMap((e) => e.links),
  ])
    add(`link:${link.id}`, canonicalJson(link));
  return units;
}

export interface DecisionVerification {
  manifestSha256: string;
  sourcesSha256: string;
  decisions: string[];
  units: string[];
}
export function verifyUsedDecisions(
  context: DecisionContext | undefined,
  model: CvMaster,
  declarations: unknown,
  resume: ResolvedResume,
): DecisionVerification {
  const units = publicationUnits(model, resume);
  if (context === undefined) {
    const entries = (declarations as { declaracoes: unknown[] }).declaracoes;
    if (entries.length > 0 || units.some((u) => u.declarations.length > 0 || u.inherits.length > 0))
      return fail();
    return {
      manifestSha256: decisionHash(null),
      sourcesSha256: decisionHash(null),
      decisions: [],
      units: units.map((u) => u.id),
    };
  }
  const state = contexts.get(context);
  if (state === undefined) return fail();
  const m = state.manifest;
  if (
    modelHash(model) !== m.modelHash ||
    decisionHash(model) !== m.modelSnapshotSha256 ||
    decisionHash(declarations) !== m.declarationsSha256
  )
    return fail();
  const selected = m.variants.find((v) => v.area === resume.area);
  if (
    selected === undefined ||
    selected.contentSha256 !== resume.manifest.contentSha256 ||
    selected.units.length !== units.length
  )
    return fail();
  const all = new Map(m.variants.flatMap((v) => v.units).map((u) => [u.id, u]));
  const used = new Set<string>();
  const collected = new Set<string>();
  const collect = (id: string): void => {
    if (collected.has(id)) return;
    collected.add(id);
    const u = all.get(id);
    if (u === undefined) return fail();
    u.decisions.forEach((id) => used.add(id));
    u.inherits.forEach(collect);
  };
  const entries = (declarations as { declaracoes: { id: string }[] }).declaracoes;
  if (!unique(entries.map((d) => d.id))) return fail();
  for (const u of units) {
    const mapped = selected.units.find((n) => n.id === u.id);
    if (
      mapped === undefined ||
      mapped.textSha256 !== decisionHash(u.text) ||
      u.inherits.some((parent) => !mapped.inherits.includes(parent))
    )
      return fail();
    collect(u.id);
    const forUnit = new Set<string>();
    const gathered = new Set<string>();
    const gather = (id: string): void => {
      if (gathered.has(id)) return;
      gathered.add(id);
      const n = all.get(id);
      if (!n) return fail();
      n.decisions.forEach((d) => forUnit.add(d));
      n.inherits.forEach(gather);
    };
    gather(u.id);
    for (const id of forUnit) {
      const d = m.decisions.find((d) => d.id === id);
      if (d?.scope.kind === 'knowledge' && u.id.startsWith('skill:') && d.scope.subject !== u.text)
        return fail();
    }
    // Uma decisão sobre uma habilidade não cobre outro item da mesma declaração composta.
    if (
      u.id.startsWith('skill:') &&
      m.decisions.some((d) => d.scope.kind === 'knowledge' && d.scope.subject === u.text) &&
      ![...forUnit].some((id) =>
        m.decisions.some(
          (d) => d.id === id && d.scope.kind === 'knowledge' && d.scope.subject === u.text,
        ),
      )
    )
      return fail();
    for (const id of u.declarations)
      if (![...forUnit].some((d) => m.decisions.find((v) => v.id === d)?.declarationId === id))
        return fail();
  }
  for (const id of used) {
    const d = m.decisions.find((d) => d.id === id);
    if (d === undefined || !entries.some((e) => e.id === d.declarationId)) return fail();
  }
  return {
    manifestSha256: state.manifestSha256,
    sourcesSha256: state.sourcesSha256,
    decisions: [...used].sort(),
    units: units.map((u) => u.id).sort(),
  };
}
