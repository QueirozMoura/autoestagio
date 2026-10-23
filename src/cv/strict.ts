import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AREAS, type Area } from '../eligibility/areas.js';
import {
  authenticateLato,
  fontSha256,
  FontTrustError,
  latoHashes,
  type LatoReference,
} from './font-policy.js';
import { extractPdfBytes } from './pdf.js';
import { DEFAULT_LAYOUT, renderResume, RenderError } from './render/index.js';
import { resolveResume, ResumeResolutionError } from './resolve.js';
import { canonicalJson, cvMasterSchema } from './schema.js';
import { completionIssues, type CompletionIssue } from './strict-completion.js';
import {
  verifyUsedDecisions,
  type DecisionContext,
  type DecisionVerification,
} from './decision-context.js';
import {
  deriveForbiddenSet,
  localMarkers,
  StrictContextError,
  type LocalContext,
} from './strict-context.js';
import { identityReport, type FontIdentityReport } from './validate/font-identity.js';
import { validateRenderedPdf, type ValidationReport } from './validate/index.js';

const POLICY_LAYOUT = structuredClone(DEFAULT_LAYOUT);
const declarationSchema = z
  .object({
    schemaVersion: z.literal(1),
    declaracoes: z.array(z.object({ id: z.string().min(1), aprovada: z.boolean() }).loose()),
  })
  .loose();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const INPUT_KEYS = new Set([
  'model',
  'masterPdf',
  'referenceFonts',
  'declarations',
  'localContext',
  'area',
  'decisionContext',
]);
const objectHash = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(value)) as unknown))
    .digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const refsOf = (fonts: { regular: Buffer; bold: Buffer }): LatoReference[] => [
  { name: 'Lato-Regular', bytes: fonts.regular },
  { name: 'Lato-Bold', bytes: fonts.bold },
];

export interface StrictResumeInput {
  model: unknown;
  /** Bytes originais: o fluxo calcula o hash e extrai o mestre por conta própria. */
  masterPdf: Uint8Array;
  declarations: unknown;
  referenceFonts: readonly LatoReference[];
  localContext: LocalContext;
  area?: Area;
  decisionContext?: DecisionContext;
}
export type StrictIssue =
  | CompletionIssue
  | 'INPUT'
  | 'MODEL'
  | 'MASTER'
  | 'REFERENCES'
  | 'DECLARATIONS'
  | 'LOCAL_CONTEXT'
  | 'RESOLUTION'
  | 'RENDER';
export interface StrictBindings {
  modelSha256: string;
  masterSha256: string;
  declarationsSha256: string;
  resolvedSha256: string;
  manifestSha256: string;
  forbiddenSha256: string;
  layoutSha256: string;
  localContextSha256: string;
  pdfSha256: string;
  references: Record<LatoReference['name'], string>;
  decisions: DecisionVerification;
}
export interface StrictValidationReport {
  ok: boolean;
  complete: boolean;
  fontIdentity: FontIdentityReport;
  referenceIntegrity: 'not-run' | 'failed' | 'verified';
  issues: StrictIssue[];
  diagnostic: ValidationReport | null;
  bindings: StrictBindings | null;
}
export interface StrictResumeResult {
  report: StrictValidationReport;
  /** Cada leitura devolve uma cópia: o PDF atestado nunca é exposto como buffer compartilhado. */
  artifact?: { pdfSha256: string; pages: number; readBytes(): Buffer };
}

/**
 * Única entrada de conclusão estrita. Não recebe PDF candidato, ForbiddenSet, extratores, flags de aprovação
 * ou hashes esperados do chamador. Não grava arquivos nem cria aprovações. Erros inesperados continuam subindo.
 */
export async function renderAndValidateResume(
  input: StrictResumeInput,
): Promise<StrictResumeResult> {
  let integrity: StrictValidationReport['referenceIntegrity'] = 'not-run';
  const failure = (issue: StrictIssue): StrictResumeResult => ({
    report: freeze({
      ok: false,
      complete: false,
      fontIdentity: identityReport('not-run'),
      referenceIntegrity: integrity,
      issues: [issue],
      diagnostic: null,
      bindings: null,
    }),
  });
  if (
    !isRecord(input) ||
    Object.keys(input).some((k) => !INPUT_KEYS.has(k)) ||
    !(input.masterPdf instanceof Uint8Array) ||
    input.masterPdf.length === 0 ||
    input.masterPdf.length > 8 * 1024 * 1024 ||
    (input.area !== undefined && !(AREAS as readonly string[]).includes(input.area))
  )
    return failure('INPUT');
  // Todos os objetos e buffers externos são fotografados antes do primeiro await.
  const parsed = cvMasterSchema.safeParse(input.model);
  if (!parsed.success) return failure('MODEL');
  const declarations = declarationSchema.safeParse(structuredClone(input.declarations));
  if (!declarations.success) return failure('DECLARATIONS');
  const model = parsed.data;
  const master = Buffer.from(input.masterPdf);
  const area = input.area;
  const layout = structuredClone(POLICY_LAYOUT);
  const sourceHash = objectHash(model);
  // Contextos opacos são obtidos da fronteira de confiança antes do primeiro await.
  const decisionContext = input.decisionContext;
  let fonts: { regular: Buffer; bold: Buffer };
  let markers: string[];
  let forbidden: ReturnType<typeof deriveForbiddenSet>;
  try {
    fonts = authenticateLato(input.referenceFonts);
    integrity = 'verified';
    markers = localMarkers(structuredClone(input.localContext));
    forbidden = deriveForbiddenSet(model);
  } catch (error) {
    if (error instanceof FontTrustError) {
      integrity = 'failed';
      return failure('REFERENCES');
    }
    if (error instanceof StrictContextError) return failure(error.code);
    throw error;
  }
  const masterSha256 = fontSha256(master);
  if (masterSha256 !== model.master.sha256) return failure('MASTER');
  // Nenhuma PdfExtraction fornecida pelo chamador é tratada como evidência.
  const extraction = await extractPdfBytes(master, model.master.label);
  if (
    fontSha256(master) !== masterSha256 ||
    extraction.sha256 !== masterSha256 ||
    extraction.pages !== model.master.pages
  )
    return failure('MASTER');
  let resolved: ReturnType<typeof resolveResume>;
  try {
    resolved = resolveResume(model, { extraction, ...(area === undefined ? {} : { area }) });
  } catch (error) {
    if (error instanceof ResumeResolutionError) return failure('RESOLUTION');
    throw error;
  }
  const { manifest, ...content } = resolved;
  let decisionVerification: DecisionVerification;
  try {
    decisionVerification = verifyUsedDecisions(decisionContext, model, declarations.data, resolved);
  } catch (error) {
    if (error instanceof StrictContextError) return failure(error.code);
    throw error;
  }
  if (manifest.contentSha256 !== objectHash(content)) return failure('BINDINGS');
  const resolvedSha256 = objectHash(resolved);
  const renderInput = structuredClone(resolved);
  const renderLayout = structuredClone(layout);
  const renderFonts = authenticateLato(refsOf(fonts));
  let rendered: Awaited<ReturnType<typeof renderResume>>;
  try {
    rendered = await renderResume(renderInput, { layout: renderLayout, fonts: renderFonts });
    authenticateLato(refsOf(renderFonts));
  } catch (error) {
    if (error instanceof FontTrustError) {
      integrity = 'failed';
      return failure('REFERENCES');
    }
    if (error instanceof RenderError) return failure('RENDER');
    throw error;
  }
  if (
    objectHash(renderInput) !== resolvedSha256 ||
    objectHash(renderLayout) !== objectHash(layout) ||
    rendered.sourceContentSha256 !== manifest.contentSha256 ||
    !(rendered.bytes instanceof Uint8Array)
  )
    return failure('BINDINGS');
  const pdf = Buffer.from(rendered.bytes);
  const pdfSha256 = fontSha256(pdf);
  if (
    rendered.pdfSha256 !== pdfSha256 ||
    !Number.isInteger(rendered.pages) ||
    rendered.pages < 1 ||
    rendered.pages > layout.pages.max ||
    !Number.isInteger(rendered.fit.stepIndex) ||
    rendered.fit.stepIndex < 0 ||
    rendered.fit.stepIndex >= layout.fit.length ||
    objectHash(layout.fit[rendered.fit.stepIndex]) !== objectHash(rendered.fit.step)
  )
    return failure('BINDINGS');
  const expected = structuredClone(resolved);
  const validationLayout = structuredClone(layout);
  const validationForbidden = structuredClone(forbidden);
  const validationMarkers = [...markers];
  const validationFonts = authenticateLato(refsOf(fonts));
  const validationRefs = refsOf(validationFonts);
  const beforeValidation = objectHash({
    expected,
    validationLayout,
    validationForbidden,
    validationMarkers,
  });
  const validationOptions = {
    poppler: 'require',
    layout: validationLayout,
    expectedPages: rendered.pages,
    forbidden: validationForbidden,
    localMarkers: validationMarkers,
    referenceFonts: validationRefs,
  } as const;
  const optionsHash = objectHash({ ...validationOptions, referenceFonts: null });
  const diagnostic = await validateRenderedPdf(pdf, expected, validationOptions);
  const issues: StrictIssue[] = completionIssues(diagnostic, { pdfSha256, pages: rendered.pages });
  if (
    fontSha256(pdf) !== pdfSha256 ||
    objectHash({ expected, validationLayout, validationForbidden, validationMarkers }) !==
      beforeValidation ||
    objectHash(model) !== sourceHash ||
    objectHash(resolved) !== resolvedSha256
  )
    issues.push('BINDINGS');
  if (
    validationOptions.referenceFonts !== validationRefs ||
    objectHash({ ...validationOptions, referenceFonts: null }) !== optionsHash
  )
    issues.push('BINDINGS');
  try {
    authenticateLato(validationRefs);
  } catch (error) {
    if (!(error instanceof FontTrustError)) throw error;
    integrity = 'failed';
    issues.push('REFERENCES');
  }
  const complete = issues.length === 0;
  const bindings: StrictBindings = {
    modelSha256: sourceHash,
    masterSha256,
    declarationsSha256: objectHash(declarations.data),
    resolvedSha256: manifest.contentSha256,
    manifestSha256: objectHash(manifest),
    forbiddenSha256: objectHash(forbidden),
    layoutSha256: objectHash(layout),
    localContextSha256: objectHash(markers),
    pdfSha256,
    references: latoHashes(),
    decisions: decisionVerification,
  };
  const report: StrictValidationReport = freeze(
    structuredClone({
      ok: complete,
      complete,
      fontIdentity: diagnostic.fontIdentity,
      referenceIntegrity: integrity,
      issues: [...new Set(issues)],
      diagnostic,
      bindings,
    }),
  );
  const sealedPdf = complete ? Buffer.from(pdf) : undefined;
  return sealedPdf !== undefined
    ? {
        report,
        artifact: Object.freeze({
          pdfSha256,
          pages: rendered.pages,
          readBytes: () => Buffer.from(sealedPdf),
        }),
      }
    : { report };
}
