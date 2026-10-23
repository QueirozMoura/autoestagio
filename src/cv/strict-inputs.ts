import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Area } from '../eligibility/areas.js';
import { PROJECT_ROOT } from '../utils/paths.js';
import {
  decisionHash,
  decisionManifestSchema,
  verifyDecisionContext,
  type DecisionContext,
} from './decision-context.js';
import { authenticateLato, FontTrustError, type LatoReference } from './font-policy.js';
import { FONT_DIR, FONT_FILES } from './render/fonts.js';
import { cvMasterSchema, modelHash, type CvMaster } from './schema.js';
import { isModelFullyApproved, requiredBlocksWithoutApproval } from './selection.js';
import type { StrictResumeInput } from './strict.js';
import { localMarkers, StrictContextError, type LocalContext } from './strict-context.js';
import { defaultRunner, type PopplerRunner } from './validate/poppler.js';

/**
 * Carregador de produção das entradas do fluxo estrito. Só lê, valida e delega: não renderiza, não
 * valida PDF, não grava arquivos e não cria aprovações, âncoras ou decisões. A geração continua sendo
 * exclusivamente `renderAndValidateResume`.
 *
 * Raiz de confiança: o SHA-256 do arquivo de âncora é uma referência EXPLÍCITA, fornecida por quem
 * executa (nunca derivada de arquivos em `data/`). O arquivo é lido, conferido contra essa referência e
 * só então o seu conteúdo (`trusted`) é usado como âncora de `verifyDecisionContext`.
 */

export const CV_VARIANTS = [
  { id: 'generico', name: 'Genérica', area: null },
  { id: 'desenvolvimento', name: 'Desenvolvimento', area: 'desenvolvimento' },
  { id: 'qa', name: 'QA', area: 'qa' },
  { id: 'infraestrutura', name: 'Infraestrutura', area: 'infraestrutura' },
  { id: 'banco-de-dados', name: 'Banco de Dados', area: 'banco-de-dados' },
] as const satisfies readonly { id: string; name: string; area: Area | null }[];
export type CvVariant = (typeof CV_VARIANTS)[number];
export type CvVariantId = CvVariant['id'];

/** Âncora autorizada para a configuração local atual. Nunca é escolhida por data. */
export const ANCHOR_FILE = 'data/cv-decisions/authorization-2026-10-23.json';
export const DECLARATIONS_FILE = 'data/cv-declarations.json';
const APPROVALS_DIR = 'data/cv-approvals';
const DECISIONS_DIR = 'data/cv-decisions';

const MESSAGES = {
  MODEL_MISSING: 'O modelo do currículo não foi encontrado. Rode "cv extract" primeiro.',
  MODEL_INVALID: 'O modelo do currículo está corrompido ou fora do formato esperado.',
  MASTER_MISSING:
    'O PDF mestre aprovado não está disponível (perfil sem currículo aprovado ou arquivo ausente).',
  MASTER_MISMATCH:
    'O PDF mestre não confere com o aprovado no perfil e no modelo (SHA-256 diferente).',
  DECLARATIONS_MISSING: 'O arquivo de declarações não foi encontrado.',
  DECLARATIONS_INVALID: 'O arquivo de declarações está corrompido ou não confere com as decisões.',
  ANCHOR_REFERENCE_MISSING:
    'Referência da âncora de confiança não informada. Informe o SHA-256 do arquivo de âncora (--ancora-sha256).',
  ANCHOR_MISSING: 'O arquivo de âncora de confiança não foi encontrado.',
  ANCHOR_MISMATCH: 'O arquivo de âncora não corresponde à referência de confiança informada.',
  ANCHOR_INVALID: 'O arquivo de âncora está corrompido ou fora do formato esperado.',
  APPROVAL_MISSING: 'A aprovação global do modelo não foi encontrada.',
  APPROVAL_INVALID: 'A aprovação global está corrompida ou não confere com a âncora.',
  APPROVAL_STALE: 'A aprovação está obsoleta: o modelo mudou depois de aprovado.',
  DECISIONS_MISSING: 'O manifesto de decisões não foi encontrado.',
  DECISIONS_INVALID: 'O manifesto de decisões é inválido ou diverge da âncora.',
  VARIANT_UNKNOWN: 'Variante inexistente.',
  VARIANT_NOT_ELIGIBLE: 'A variante não está aprovada para geração.',
  VARIANT_NOT_IN_DECISIONS: 'O manifesto de decisões não cobre esta variante.',
  FONTS_INVALID: 'As fontes de referência estão ausentes ou não conferem com a política fixada.',
  LOCAL_CONTEXT_INVALID: 'Não foi possível determinar o contexto local necessário à validação.',
  POPPLER_MISSING: 'O Poppler (pdftotext) é obrigatório e não está disponível.',
  UNSAFE_FILE:
    'Um arquivo privado tem tipo ou permissões inseguras (link simbólico, não regular ou acessível a outros usuários).',
} as const;
export type StrictInputsErrorCode = keyof typeof MESSAGES;

/** Mensagem fixa em português: nunca inclui caminhos, hashes nem conteúdo dos arquivos. */
export class StrictInputsError extends Error {
  constructor(readonly code: StrictInputsErrorCode) {
    super(MESSAGES[code]);
    this.name = 'StrictInputsError';
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[a-f0-9]{64}$/u;
const PRIVATE_LIMIT = 16 * 1024 * 1024;
const MASTER_LIMIT = 8 * 1024 * 1024;
const FONT_LIMIT = 2 * 1024 * 1024;

type Missing =
  | 'MODEL_MISSING'
  | 'MASTER_MISSING'
  | 'DECLARATIONS_MISSING'
  | 'ANCHOR_MISSING'
  | 'APPROVAL_MISSING'
  | 'DECISIONS_MISSING'
  | 'FONTS_INVALID';

/** Lê arquivo regular, sem link simbólico, dentro do limite; `privateMode` exige 0600 (sem acesso a grupo/outros). */
function readFile(path: string, missing: Missing, limit: number, privateMode: boolean): Buffer {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new StrictInputsError(missing);
  }
  if (!stat.isFile() || stat.size > limit || (privateMode && (stat.mode & 0o077) !== 0))
    throw new StrictInputsError('UNSAFE_FILE');
  try {
    return readFileSync(path);
  } catch {
    throw new StrictInputsError(missing);
  }
}

function parseJson(bytes: Buffer, code: StrictInputsErrorCode): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new StrictInputsError(code);
  }
}

/** Caminho relativo vindo de um registro: precisa ficar dentro do diretório esperado, sem links. */
function resolveInside(
  root: string,
  rel: string,
  dir: string,
  code: StrictInputsErrorCode,
): string {
  if (typeof rel !== 'string' || rel.length === 0 || isAbsolute(rel))
    throw new StrictInputsError(code);
  const base = resolve(root, dir);
  const target = resolve(root, rel);
  const inside = relative(base, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    throw new StrictInputsError(code);
  try {
    if (realpathSync(target) !== join(realpathSync(base), inside))
      throw new StrictInputsError('UNSAFE_FILE');
  } catch (error) {
    if (error instanceof StrictInputsError) throw error;
    // Arquivo inexistente: quem lê decide o erro específico.
  }
  return target;
}

const anchorSchema = z.looseObject({
  recordType: z.literal('authorized-reconciliation-integrity-anchor'),
  trusted: z.strictObject({
    manifestSha256: z.string().regex(HEX64),
    sourcesSha256: z.string().regex(HEX64),
    modelHash: z.string().regex(HEX64),
  }),
  bundlePath: z.string().min(1),
  globalApproval: z.looseObject({
    path: z.string().min(1),
    sha256: z.string().regex(HEX64),
    modelHash: z.string().regex(HEX64),
  }),
});
const approvalSchema = z.looseObject({
  schemaVersion: z.literal(1),
  decision: z.literal('explicit-global-editorial-approval'),
  by: z.literal('proprietario'),
  scope: z.looseObject({
    kind: z.literal('global-editorial-content'),
    modelHash: z.string().regex(HEX64),
    // O que a aprovação global NÃO concede precisa continuar negado.
    individualDeclarationsApproved: z.literal(false),
    draftOrRejectedVariantsReleased: z.literal(false),
    strictCompletionAuthorized: z.literal(false),
    validForDifferentModelHash: z.literal(false),
  }),
});
const declarationsSchema = z.looseObject({
  schemaVersion: z.literal(1),
  declaracoes: z.array(z.looseObject({ id: z.string().min(1), aprovada: z.boolean() })),
});

export interface StrictInputsOptions {
  /** Raiz do projeto (padrão: a raiz real). Os registros privados são lidos dentro dela. */
  root?: string;
  modelPath: string;
  /** PDF mestre e o SHA-256 aprovado no perfil. */
  masterPdf: { path: string; sha256: string } | undefined;
  /** Referência explícita e externa: SHA-256 do arquivo de âncora. */
  anchorSha256: string | undefined;
  anchorFile?: string;
  fontDir?: string;
  localContext?: LocalContext;
  /** Injetável nos testes. */
  popplerRunner?: PopplerRunner;
}

export interface LoadedStrictInputs {
  /** Áreas (null = genérica) cobertas pelo manifesto de decisões. */
  readonly manifestAreas: readonly (Area | null)[];
  /** Cópias novas a cada chamada, no formato exato de `renderAndValidateResume`. */
  inputFor(id: string): StrictResumeInput;
}

export function popplerAvailable(runner: PopplerRunner = defaultRunner): boolean {
  return runner('pdftotext', ['-v'], Buffer.alloc(0)).status === 0;
}

const variantOf = (id: string): CvVariant => {
  const variant = CV_VARIANTS.find((v) => v.id === id);
  if (variant === undefined) throw new StrictInputsError('VARIANT_UNKNOWN');
  return variant;
};

function loadModelFile(modelPath: string): CvMaster {
  const bytes = readFile(modelPath, 'MODEL_MISSING', PRIVATE_LIMIT, true);
  const parsed = cvMasterSchema.safeParse(parseJson(bytes, 'MODEL_INVALID'));
  if (!parsed.success) throw new StrictInputsError('MODEL_INVALID');
  return parsed.data;
}

function loadRest(model: CvMaster, options: StrictInputsOptions): LoadedStrictInputs {
  const root = realpathSync(options.root ?? PROJECT_ROOT);
  const currentHash = modelHash(model);

  // 1. Raiz de confiança: referência externa explícita -> arquivo de âncora.
  if (options.anchorSha256 === undefined || !HEX64.test(options.anchorSha256))
    throw new StrictInputsError('ANCHOR_REFERENCE_MISSING');
  const anchorPath = resolveInside(
    root,
    options.anchorFile ?? ANCHOR_FILE,
    DECISIONS_DIR,
    'ANCHOR_MISSING',
  );
  const anchorBytes = readFile(anchorPath, 'ANCHOR_MISSING', PRIVATE_LIMIT, true);
  if (sha256(anchorBytes) !== options.anchorSha256) throw new StrictInputsError('ANCHOR_MISMATCH');
  const anchorParsed = anchorSchema.safeParse(parseJson(anchorBytes, 'ANCHOR_INVALID'));
  if (!anchorParsed.success) throw new StrictInputsError('ANCHOR_INVALID');
  const anchor = anchorParsed.data;

  // 2. Aprovação global: confere com a âncora e com o modelo atual.
  const approvalPath = resolveInside(
    root,
    anchor.globalApproval.path,
    APPROVALS_DIR,
    'APPROVAL_INVALID',
  );
  const approvalBytes = readFile(approvalPath, 'APPROVAL_MISSING', PRIVATE_LIMIT, true);
  if (sha256(approvalBytes) !== anchor.globalApproval.sha256)
    throw new StrictInputsError('APPROVAL_INVALID');
  const approvalParsed = approvalSchema.safeParse(parseJson(approvalBytes, 'APPROVAL_INVALID'));
  if (
    !approvalParsed.success ||
    approvalParsed.data.scope.modelHash !== anchor.globalApproval.modelHash ||
    anchor.globalApproval.modelHash !== anchor.trusted.modelHash
  )
    throw new StrictInputsError('APPROVAL_INVALID');
  if (
    anchor.trusted.modelHash !== currentHash ||
    model.approval?.modelHash !== currentHash ||
    !isModelFullyApproved(model)
  )
    throw new StrictInputsError('APPROVAL_STALE');

  // 3. Declarações.
  const declarationsBytes = readFile(
    join(root, DECLARATIONS_FILE),
    'DECLARATIONS_MISSING',
    PRIVATE_LIMIT,
    true,
  );
  const declarationsParsed = declarationsSchema.safeParse(
    parseJson(declarationsBytes, 'DECLARATIONS_INVALID'),
  );
  if (!declarationsParsed.success) throw new StrictInputsError('DECLARATIONS_INVALID');
  const declarations = declarationsParsed.data;

  // 4. Decisões: a verificação é de `verifyDecisionContext`, ancorada em `trusted`.
  const bundlePath = resolveInside(root, anchor.bundlePath, DECISIONS_DIR, 'DECISIONS_INVALID');
  const bundleBytes = readFile(bundlePath, 'DECISIONS_MISSING', PRIVATE_LIMIT, true);
  const bundle = parseJson(bundleBytes, 'DECISIONS_INVALID') as {
    manifest?: unknown;
    sources?: unknown;
  } | null;
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle))
    throw new StrictInputsError('DECISIONS_INVALID');
  let decisionContext: DecisionContext;
  try {
    decisionContext = verifyDecisionContext(
      { manifest: bundle.manifest, sources: bundle.sources },
      anchor.trusted,
    );
  } catch (error) {
    if (error instanceof StrictContextError) throw new StrictInputsError('DECISIONS_INVALID');
    throw error;
  }
  const manifest = decisionManifestSchema.parse(bundle.manifest);
  if (manifest.declarationsSha256 !== decisionHash(declarations))
    throw new StrictInputsError('DECLARATIONS_INVALID');
  if (manifest.modelSnapshotSha256 !== decisionHash(model))
    throw new StrictInputsError('APPROVAL_STALE');

  // 5. PDF mestre: o mesmo hash no perfil e no modelo.
  if (options.masterPdf === undefined) throw new StrictInputsError('MASTER_MISSING');
  const masterBytes = readFile(options.masterPdf.path, 'MASTER_MISSING', MASTER_LIMIT, false);
  const masterHash = sha256(masterBytes);
  if (masterHash !== options.masterPdf.sha256 || masterHash !== model.master.sha256)
    throw new StrictInputsError('MASTER_MISMATCH');

  // 6. Fontes de referência autenticadas pela política fixada.
  const fontDir = options.fontDir ?? FONT_DIR;
  const referenceFonts: LatoReference[] = [
    {
      name: 'Lato-Regular',
      bytes: readFile(join(fontDir, FONT_FILES.regular), 'FONTS_INVALID', FONT_LIMIT, false),
    },
    {
      name: 'Lato-Bold',
      bytes: readFile(join(fontDir, FONT_FILES.bold), 'FONTS_INVALID', FONT_LIMIT, false),
    },
  ];
  try {
    authenticateLato(referenceFonts);
  } catch (error) {
    if (error instanceof FontTrustError) throw new StrictInputsError('FONTS_INVALID');
    throw error;
  }

  // 7. Contexto local da validação (marcadores que não podem vazar para o PDF).
  const localContext: LocalContext = options.localContext ?? {
    projectRoot: root,
    userName: userInfo().username,
    hostName: hostname(),
  };
  try {
    localMarkers(localContext);
  } catch (error) {
    if (error instanceof StrictContextError) throw new StrictInputsError('LOCAL_CONTEXT_INVALID');
    throw error;
  }

  // 8. Poppler é obrigatório; sem fallback.
  if (!popplerAvailable(options.popplerRunner)) throw new StrictInputsError('POPPLER_MISSING');

  const manifestAreas = Object.freeze(manifest.variants.map((v) => v.area));
  return {
    manifestAreas,
    inputFor(id: string): StrictResumeInput {
      const variant = variantOf(id);
      if (requiredBlocksWithoutApproval(model, variant.area ?? undefined).length > 0)
        throw new StrictInputsError('VARIANT_NOT_ELIGIBLE');
      if (!manifestAreas.includes(variant.area))
        throw new StrictInputsError('VARIANT_NOT_IN_DECISIONS');
      return {
        model: structuredClone(model),
        masterPdf: Buffer.from(masterBytes),
        declarations: structuredClone(declarations),
        referenceFonts: referenceFonts.map((f) => ({ name: f.name, bytes: Buffer.from(f.bytes) })),
        localContext: { ...localContext },
        decisionContext,
        ...(variant.area === null ? {} : { area: variant.area }),
      };
    },
  };
}

/** Carrega e verifica todas as entradas privadas do fluxo estrito. Lança `StrictInputsError`. */
export function loadStrictInputs(options: StrictInputsOptions): LoadedStrictInputs {
  return loadRest(loadModelFile(options.modelPath), options);
}

export type EditorialState = 'aprovada' | 'rascunho' | 'rejeitada' | 'ausente';
export interface VariantInfo {
  id: CvVariantId;
  name: string;
  /** Estado editorial do resumo da variante no modelo. */
  editorial: EditorialState;
  /** Seleção estrita elegível: modelo integralmente aprovado e todos os blocos obrigatórios aprovados. */
  selectionEligible: boolean;
  /** Pré-condições locais (âncora, decisões, PDF mestre, fontes, Poppler) verificadas para a variante. */
  preconditions: { verified: true } | { verified: false; code: StrictInputsErrorCode };
  /** Sempre "not-run": só `renderAndValidateResume` atesta a validação estrita. */
  strictValidation: 'not-run';
}

function editorialState(model: CvMaster, area: Area | null): EditorialState {
  const mine = model.summary.variants.filter((v) =>
    area === null ? v.areas.length === 0 : v.areas.includes(area),
  );
  if (mine.some((v) => v.status === 'aprovado' && v.approvedAt !== undefined)) return 'aprovada';
  if (mine.some((v) => v.status === 'rascunho')) return 'rascunho';
  if (mine.some((v) => v.status === 'rejeitado')) return 'rejeitada';
  return 'ausente';
}

/** Descreve as variantes sem expor conteúdo, caminhos ou hashes e sem renderizar nada. */
export function describeVariants(
  model: CvMaster,
  loaded: LoadedStrictInputs | StrictInputsErrorCode,
): VariantInfo[] {
  const fullyApproved = isModelFullyApproved(model);
  return CV_VARIANTS.map((variant): VariantInfo => {
    const area = variant.area ?? undefined;
    const editorial = editorialState(model, variant.area);
    const selectionEligible =
      fullyApproved &&
      editorial === 'aprovada' &&
      requiredBlocksWithoutApproval(model, area).length === 0;
    let preconditions: VariantInfo['preconditions'];
    if (typeof loaded === 'string') preconditions = { verified: false, code: loaded };
    else if (!loaded.manifestAreas.includes(variant.area))
      preconditions = { verified: false, code: 'VARIANT_NOT_IN_DECISIONS' };
    else preconditions = { verified: true };
    return {
      id: variant.id,
      name: variant.name,
      editorial,
      selectionEligible,
      preconditions,
      strictValidation: 'not-run',
    };
  });
}

/** Lista as variantes; falhas de pré-condição viram estado "indisponível", não exceção. */
export function inspectVariants(options: StrictInputsOptions): VariantInfo[] {
  const model = loadModelFile(options.modelPath);
  try {
    return describeVariants(model, loadRest(model, options));
  } catch (error) {
    if (error instanceof StrictInputsError) return describeVariants(model, error.code);
    throw error;
  }
}
